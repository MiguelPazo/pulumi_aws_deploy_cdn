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
 * Create OAC
 */
const cdnOac = new aws.cloudfront.OriginAccessControl("example", {
    description: `${config.generalPrefix}-oac`,
    originAccessControlOriginType: "s3",
    signingBehavior: "always",
    signingProtocol: "sigv4",
});

/**
 * Create bucket for static content and upload content
 */
const mainBucket = new aws.s3.Bucket(`${config.project}-bucket`, {
    bucket: `${config.generalPrefix}-bucket`,
    acl: "private",
    tags: {
        ...config.generalTags,
        Name: `${config.generalPrefix}-bucket`
    }
});

new aws.s3.BucketOwnershipControls(`${config.project}-bucket-access-ownership`, {
    bucket: mainBucket.id,
    rule: {
        objectOwnership: "ObjectWriter",
    },
});

const webContentPath = path.join(process.cwd(), 'data');

crawlDirectory(
    webContentPath,
    (filePath: string) => {
        const relativeFilePath = filePath.replace(webContentPath + "/", "");

        new aws.s3.BucketObject(relativeFilePath, {
            key: relativeFilePath,
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
const logsBucket = new aws.s3.Bucket(`${config.project}-bucket-logs`, {
    bucket: `${config.generalPrefix}-bucket-logs`,
    acl: "private",
    tags: {
        ...config.generalTags,
        Name: `${config.generalPrefix}-bucket-logs`
    }
});

new aws.s3.BucketOwnershipControls(`${config.project}-bucket-access-logs-ownership`, {
    bucket: logsBucket.id,
    rule: {
        objectOwnership: "ObjectWriter",
    },
});


// new aws.s3.BucketPublicAccessBlock(`${config.project}-bucket-access-logs-block`, {
//     bucket: logsBucket.id,
//     blockPublicAcls: false,
//     blockPublicPolicy: false,
//     ignorePublicAcls: false,
//     restrictPublicBuckets: false
// });


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
 * CloudFront function
 */
const fnRewrite = new aws.cloudfront.Function(`${config.project}-cdn-function`, {
    name: `${config.generalPrefix}-cdn-function-rewrite`,
    comment: `${config.generalPrefix}-cdn-function-rewrite`,
    runtime: "cloudfront-js-1.0",
    publish: true,
    code: fs.readFileSync(`${__dirname}/functions/rewrite.js`, "utf8")
});


/**
 * CDN Headers response
 */
const cdnHeaderPolicy = new aws.cloudfront.ResponseHeadersPolicy(`${config.project}-header-policy`, {
    name: `${config.generalPrefix}-header-policy`,
    securityHeadersConfig: {
        contentTypeOptions: {
            override: true
        },
        frameOptions: {
            override: true,
            frameOption: "SAMEORIGIN"
        },
        xssProtection: {
            override: true,
            modeBlock: true,
            protection: true
        },
        strictTransportSecurity: {
            override: true,
            accessControlMaxAgeSec: 31536000,
            includeSubdomains: true,
            preload: true
        },
        contentSecurityPolicy: {
            override: true,
            contentSecurityPolicy: config.headerContentSecurityPolicy
        }
    },
    customHeadersConfig: {
        items: [
            {
                override: true,
                header: "Cache-Control",
                value: "no-cache='Set-Cookie'"
            },
        ]
    }
});

/**
 * CDN
 */
const cdn = new aws.cloudfront.Distribution(`${config.project}-cdn`, {
    enabled: true,
    aliases: [config.domainTarget],

    origins: [
        {
            originId: mainBucket.arn,
            domainName: pulumi.interpolate`${mainBucket.bucket}.s3.us-east-1.amazonaws.com`,
            originAccessControlId: cdnOac.id
        },
    ],

    defaultRootObject: "index.html",

    defaultCacheBehavior: {
        targetOriginId: mainBucket.arn,
        viewerProtocolPolicy: "redirect-to-https",
        allowedMethods: ["GET", "HEAD", "OPTIONS"],
        cachedMethods: ["GET", "HEAD", "OPTIONS"],
        responseHeadersPolicyId: cdnHeaderPolicy.id,
        functionAssociations: [
            {
                eventType: 'viewer-request',
                functionArn: fnRewrite.arn
            }
        ],
        compress: true,
        minTtl: 0,
        defaultTtl: config.ttl,
        maxTtl: config.ttl,

        forwardedValues: {
            cookies: {forward: "none"},
            queryString: false,
        },
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
 * Permissions to S3
 */
new aws.s3.BucketPolicy(`${config.project}-bucket-policy`, {
    bucket: mainBucket.id,
    policy: pulumi.all([mainBucket.arn, cdn.arn])
        .apply(x => {
            const policy = JSON.stringify({
                Version: "2012-10-17",
                Statement: [
                    {
                        "Effect": "Allow",
                        "Principal": {
                            "Service": "cloudfront.amazonaws.com"
                        },
                        "Action": "s3:GetObject",
                        "Resource": `${x[0]}/*`,
                        "Condition": {
                            "StringEquals": {
                                "AWS:SourceArn": x[1]
                            }
                        }
                    }
                ]
            });

            return policy;
        }),
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
