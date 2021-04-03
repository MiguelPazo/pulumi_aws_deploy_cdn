# Description
This project deploy a CDN in AWS CloudFront with S3 as origin. Is required a subdomain configured in Route53 and SSL certificates created in other pulumi stack that will be referenced here.

For create Route53 zones: https://github.com/MiguelPazo/pulumi_aws_create_subdomains
For create SSL certificates: https://github.com/MiguelPazo/pulumi_aws_create_certificates

##### 1. Set enviroment variables for AWS:
```
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
```

##### 2. Create config file in %userprofile%/.aws
Check this guide:

```
https://www.pulumi.com/docs/intro/cloud-providers/aws/setup/
```

##### 3. Set PULUMI_ACCESS_TOKEN for pulumi
```
export PULUMI_ACCESS_TOKEN=
```

Check this guides:
```
https://www.pulumi.com/docs/reference/cli/pulumi_login/
https://www.pulumi.com/docs/guides/continuous-delivery/troubleshooting-guide/#pulumi-access-token
```

##### 4. Create stack
For deploy this infrastructure, you need to init pulumi stack first with this command:

```
pulumi stack init dev
```

##### 5. Set config variables
```
pulumi config set aws:profile profile
pulumi config set aws:region us-east-1
pulumi config set generalTagName demo
pulumi config set cdnName deploy-cdn
pulumi config set ttl 60
pulumi config set targetDomain domain.com
pulumi config set referenceCerts pulumi/stack
```

Description variables:

| Variable       | Description                                                                    |
|----------------|--------------------------------------------------------------------------------|
| aws:profile    | profile created in step 2.                                                     |
| generalTagName | tag for all resoruces.                                                         |
| cdnName        | name for CDN, this is not the final domain, only a name.                       |
| ttl            | time to live for CDN caching, this time is settled in seconds.                 |
| targetDomain   | root domain for create subdomains, this should be register in Route53.         |
| referenceCerts | pulumi stack reference that was created the SSL certificate for target domain. |

##### 6. Run script
```
pulumi up 
```

If you want to run this without confirmation prompt, run this script:
```
pulumi up --yes 
```
