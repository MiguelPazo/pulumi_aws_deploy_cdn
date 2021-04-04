/**
 * Created by Miguel Pazo (https://miguelpazo.com)
 */

import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as fs from "fs";
import * as mime from "mime";
import * as path from "path";
import * as config from "./config";

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

// Sync the contents of the source directory with the S3 bucket, which will in-turn show up on the CDN.
const webContentPath = path.join(process.cwd(), 'data');
console.log("Syncing contents from local disk at", webContentPath);

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

// logsBucket is an S3 bucket that will contain the CDN's request logs.
const logsBucket = new aws.s3.Bucket(`${config.cdnName}-request-logs`,
    {
        bucket: `${config.mainBucket}-logs`,
        acl: "private",
        tags: {
            Name: `${config.cdnName}-request-logs`,
            [config.generalTagName]: "shared",
        }
    });

let certificateArn: pulumi.Input<string> = config.certificateArn;

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
    },

    // "All" is the most broad distribution, and also the most expensive.
    // "100" is the least broad, and also the least expensive.
    priceClass: "PriceClass_100",

    customErrorResponses: [
        {errorCode: 404, responseCode: 404, responsePagePath: "/cdn_errors/404.html"},
        {errorCode: 503, responseCode: 503, responsePagePath: "/cdn_errors/503.html"},
        {errorCode: 500, responseCode: 500, responsePagePath: "/cdn_errors/500.html"},
    ],

    restrictions: {
        geoRestriction: {
            restrictionType: 'none'
        },
    },

    // restrictions: {
    //     geoRestriction: {
    //         locations: ['PE'],
    //         restrictionType: 'whitelist'
    //     },
    // },

    viewerCertificate: {
        acmCertificateArn: certificateArn,
        sslSupportMethod: "sni-only",
        minimumProtocolVersion: "TLSv1.2_2019",
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

createAliasRecord(config.targetDomain, cdn);

// crawlDirectory recursive crawls the provided directory, applying the provided function
// to every file it contains. Doesn't handle cycles from symlinks.
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

// Creates a new Route53 DNS record pointing the domain to the CloudFront distribution.
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
