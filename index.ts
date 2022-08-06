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
const mainBucket = new aws.s3.Bucket(`${config.project}-bucket`, {
    bucket: `${config.generalPrefix}-bucket`,
    acl: "public-read",
    website: {
        indexDocument: "index.html",
        errorDocument: "404.html",
    },
    tags: {
        ...config.generalTags,
        Name: `${config.generalPrefix}-bucket`
    }
});

const webContentPath = path.join(process.cwd(), 'data');

crawlDirectory(
    webContentPath,
    (filePath: string) => {
        const relativeFilePath = filePath.replace(webContentPath + "/", "");

        new aws.s3.BucketObject(relativeFilePath, {
            key: relativeFilePath,
            acl: "public-read",
            bucket: mainBucket,
            contentType: mime.getType(filePath) || undefined,
            source: new pulumi.asset.FileAsset(filePath)
        }, {
            parent: mainBucket,
        });
    });


/**
 * Create CDN access logs bucket
 */
const logsBucket = new aws.s3.Bucket(`${config.project}-bucket-logs`,
    {
        bucket: `${config.generalPrefix}-bucket-logs`,
        acl: "private",
        tags: {
            ...config.generalTags,
            Name: `${config.generalPrefix}-bucket-logs`
        }
    });


/**
 * Creating LambdaEdge for modify headers
 */
let policyJson = JSON.parse(fs.readFileSync('./lambda/lambda_edge_policy.json', 'utf8'))

const lambdaEdgeRolePolicy = new aws.iam.Policy(`${config.project}-lambdaedge-role-policy`, {
    path: "/",
    policy: policyJson,
});

const roleLambdaEdge = new aws.iam.Role(`${config.project}-lambdaedge-role`, {
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
        ...config.generalTags,
        Name: `${config.generalPrefix}-lambdaedge-role`,
    }
});

new aws.iam.RolePolicyAttachment(`${config.project}-lambdaedge-role-attach`, {
    role: roleLambdaEdge.name,
    policyArn: lambdaEdgeRolePolicy.arn,
});

const lambdaCdnLogs = new aws.cloudwatch.LogGroup(`${config.project}-cdn-headers-loggroup`, {
    name: `/aws/lambda/${aws.config.region}.${config.generalPrefix}-cdn-headers-loggroup`,
    retentionInDays: 0,
    tags: config.generalTags
});

const lambdaCdn = new aws.lambda.Function(`${config.project}-cdn-headers`, {
    name: `${config.generalPrefix}-lambda-headers`,
    description: 'Lambda for modify CDN headers response',
    code: new pulumi.asset.FileArchive("./lambda/app.zip"),
    role: roleLambdaEdge.arn,
    handler: "index.handler",
    runtime: "nodejs14.x",
    publish: true,
    tags: {
        ...config.generalTags,
        Name: `${config.generalPrefix}-lambda-cdn-headers`,
    }
}, {
    dependsOn: [lambdaCdnLogs]
});


/**
 * Setting certificate and config allowed countries
 */
let certificateArn: pulumi.Input<string> = config.domainCertificateArn;
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

const cdn = new aws.cloudfront.Distribution(`${config.project}-cdn`, {
    enabled: true,
    aliases: [config.domainTarget],

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
        prefix: `${config.domainTarget}/`,
    },

    tags: {
        ...config.generalTags,
        Name: `${config.generalPrefix}-cdn`,
    }
});


/**
 * Associate CDN distribution with Route 53 registry
 */
createAliasRecord(config.domainTarget, cdn);

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
export const targetDomainEndpoint = `https://${config.domainTarget}`;
