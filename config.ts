/**
 * Created by Miguel Pazo (https://miguelpazo.com)
 */
import * as pulumi from "@pulumi/pulumi";

const configPulumi = new pulumi.Config();

export const stack = pulumi.getStack();
export const project = configPulumi.get("project");
export const appName = configPulumi.get("appName");
export const generalPrefix = `${project}-${appName}-${stack}`;

export const generalTags = {
    project: project,
    appName: appName,
    env: stack,
    iac: 'pulumi',
    iac_version: '3.35.3'
}

export const cdnName = configPulumi.get("cdnName");
export const ttl = parseInt(configPulumi.get("ttl"));
export const targetDomain = configPulumi.get("targetDomain");
export const certificateArn = configPulumi.get("certificateArn");
export const allowedCountries = configPulumi.get("allowedCountries");

