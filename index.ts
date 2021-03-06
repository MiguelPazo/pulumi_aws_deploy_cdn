/**
 * Created by Miguel Pazo (https://miguelpazo.com)
 */
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as fs from "fs";
import * as mime from "mime";
import * as path from "path";
import * as config from "./config";

/**
 * Create bucket for static content and upload content
 */
const mainBucket = new aws.s3.Bucket(`${config.cdnName}-bucket`, {
    bucket: `${config.mainBucket}`,
    acl: "public-read",
    website: {
        indexDocument: "index.html",
        errorDocument: "404.html",
    },
    tags: {
        Name: `${config.cdnName}-bucket`,
        [config.generalTagName]: "shared",
    }
});

const webContentPath = path.join(process.cwd(), 'data');

crawlDirectory(
    webContentPath,
    (filePath: string) => {
        const relativeFilePath = filePath.replace(webContentPath + "/", "");

        new aws.s3.BucketObject(
            relativeFilePath,
            {
                key: relativeFilePath,
                acl: "public-read",
                bucket: mainBucket,
                contentType: mime.getType(filePath) || undefined,
                source: new pulumi.asset.FileAsset(filePath),
            },
            {
                parent: mainBucket,
            });
    });


/**
 * Create CDN access logs bucket
 */
const logsBucket = new aws.s3.Bucket(`${config.cdnName}-request-logs`,
    {
        bucket: `${config.mainBucket}-logs`,
        acl: "private",
        tags: {
            Name: `${config.cdnName}-request-logs`,
            [config.generalTagName]: "shared",
        }
    });


/**
 * Creating LambdaEdge for modify headers
 */
let policyJson = JSON.parse(fs.readFileSync('./lambda/lambda_edge_policy.json', 'utf8'))

const lambdaEdgeRolePolicy = new aws.iam.Policy(`${config.cdnName}-lambdaedge-role-policy`, {
    path: "/",
    policy: policyJson,
});

const roleLambdaEdge = new aws.iam.Role(`${config.cdnName}-lambdaedge-role`, {
    assumeRolePolicy: {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Principal": {
                    "Service": [
                        "lambda.amazonaws.com",
                        "edgelambda.amazonaws.com"
                    ]
                },
                "Action": "sts:AssumeRole"
            }
        ]
    },
    tags: {
        Name: `${config.cdnName}-lambdaedge-role`,
        [config.generalTagName]: "shared",
    }
});

new aws.iam.RolePolicyAttachment(`${config.cdnName}-lambdaedge-role-attach`, {
    role: roleLambdaEdge.name,
    policyArn: lambdaEdgeRolePolicy.arn,
});

const lambdaCdnLogs = new aws.cloudwatch.LogGroup(`${config.generalTagName}-${config.stack}-cdn-headers-loggroup`, {
    name: `/aws/lambda/${aws.config.region}.${config.cdnName}-${config.stack}-headers`,
    retentionInDays: 0
});

const lambdaCdn = new aws.lambda.Function(`${config.generalTagName}-${config.stack}-cdn-headers`, {
    name: `${config.cdnName}-${config.stack}-headers`,
    description: 'Lambda for modify CDN headers response',
    code: new pulumi.asset.FileArchive("./lambda/app.zip"),
    role: roleLambdaEdge.arn,
    handler: "index.handler",
    runtime: "nodejs14.x",
    publish: true,
    tags: {
        Name: `${config.generalTagName}-${config.stack}-cdn-headers`,
        [config.generalTagName]: "shared",
    }
}, {
    dependsOn: [lambdaCdnLogs]
});


/**
 * Setting certificate and config allowed countries
 */
let certificateArn: pulumi.Input<string> = config.certificateArn;
let restrictions;

if (config.allowedCountries) {
    restrictions = {
        geoRestriction: {
            locations: config.allowedCountries.split(','),
            restrictionType: 'whitelist'
        },
    };
} else {
    restrictions = {
        geoRestriction: {
            restrictionType: 'none'
        },
    };
}


/**
 * Create CDN
 */
let lambdaCdnArnVersion = pulumi.all([lambdaCdn.arn, lambdaCdn.version]).apply(x => {
    return Promise.resolve(`${x[0]}:${x[1]}`);
})

const cdn = new aws.cloudfront.Distribution(`${config.cdnName}-cdn`, {
    enabled: true,
    aliases: [config.targetDomain],

    origins: [
        {
            originId: mainBucket.arn,
            domainName: mainBucket.websiteEndpoint,
            customOriginConfig: {
                originProtocolPolicy: "http-only",
                httpPort: 80,
                httpsPort: 443,
                originSslProtocols: ["TLSv1.2"],
            },
        },
    ],

    defaultRootObject: "index.html",

    defaultCacheBehavior: {
        targetOriginId: mainBucket.arn,

        viewerProtocolPolicy: "redirect-to-https",
        allowedMethods: ["GET", "HEAD", "OPTIONS"],
        cachedMethods: ["GET", "HEAD", "OPTIONS"],
        compress: true,

        forwardedValues: {
            cookies: {forward: "none"},
            queryString: false,
        },

        minTtl: 0,
        defaultTtl: config.ttl,
        maxTtl: config.ttl,

        lambdaFunctionAssociations: [
            {
                eventType: 'viewer-response',
                lambdaArn: lambdaCdnArnVersion
            }
        ]
    },

    priceClass: "PriceClass_100",

    customErrorResponses: [
        {errorCode: 404, responseCode: 404, responsePagePath: "/cdn_errors/404.html"},
        {errorCode: 503, responseCode: 503, responsePagePath: "/cdn_errors/503.html"},
        {errorCode: 500, responseCode: 500, responsePagePath: "/cdn_errors/500.html"},
    ],

    restrictions,

    viewerCertificate: {
        acmCertificateArn: certificateArn,
        sslSupportMethod: "sni-only",
        minimumProtocolVersion: "TLSv1.2_2021",
    },

    loggingConfig: {
        bucket: logsBucket.bucketDomainName,
        includeCookies: false,
        prefix: `${config.targetDomain}/`,
    },

    tags: {
        Name: `${config.cdnName}-cdn`,
        [config.generalTagName]: "shared",
    }
});


/**
 * Associate CDN distribution with Route 53 registry
 */
createAliasRecord(config.targetDomain, cdn);

function crawlDirectory(dir: string, f: (_: string) => void) {
    const files = fs.readdirSync(dir);

    for (const file of files) {
        const filePath = `${dir}/${file}`;
        const stat = fs.statSync(filePath);

        if (stat.isDirectory()) {
            crawlDirectory(filePath, f);
        }

        if (stat.isFile()) {
            f(filePath);
        }
    }
}

function createAliasRecord(targetDomain: string, distribution: aws.cloudfront.Distribution): aws.route53.Record {
    const hostedZoneId = aws.route53.getZone({name: `${targetDomain}.`}, {async: true}).then(zone => zone.zoneId);
    return new aws.route53.Record(
        targetDomain,
        {
            name: `${targetDomain}.`,
            zoneId: hostedZoneId,
            type: aws.route53.RecordTypes.A,
            aliases: [
                {
                    name: distribution.domainName,
                    zoneId: distribution.hostedZoneId,
                    evaluateTargetHealth: true,
                },
            ],
        });
}

export const bucketName = mainBucket.id;
export const cloudFrontDomain = cdn !== undefined ? cdn.domainName : '';
export const targetDomainEndpoint = `https://${config.targetDomain}`;
