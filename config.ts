/**
 * Created by Miguel Pazo (https://miguelpazo.com)
 */

import * as pulumi from "@pulumi/pulumi";

const configPulumi = new pulumi.Config();

const env = pulumi.getStack();
export const cdnName = configPulumi.get("cdnName");
export const ttl = parseInt(configPulumi.get("ttl"));
export const mainBucket = `${cdnName}-bucket`;
export const suffix = `-${pulumi.getStack()}`;
export const generalTagName = configPulumi.get("generalTagName");
export const targetDomain = configPulumi.get("targetDomain");

/**
 * Fetching certificate for target domain for CDN
 */
const referenceCerts = configPulumi.get("referenceCerts");
const certificates = new pulumi.StackReference(`${referenceCerts}`);

export const certificateArn = pulumi.output(certificates.getOutput("certificates")).apply(x => {
    for (let i in x) {
        if (x[i].domain == targetDomain) {
            return x[i].certificateArn;
        }
    }
});
