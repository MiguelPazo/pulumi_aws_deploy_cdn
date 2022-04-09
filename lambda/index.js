exports.handler = async (event, context) => {
    const response = event.Records[0].cf.response;
    const headers = response.headers;

    const headerNameSrc = 'X-Amz-Meta-Last-Modified';
    const headerNameDst = 'Last-Modified';

    if (headers[headerNameSrc.toLowerCase()]) {
        headers[headerNameDst.toLowerCase()] = [{
            key: headerNameDst,
            value: headers[headerNameSrc.toLowerCase()][0].value,
        }];
        console.log(`Response header "${headerNameDst}" was set to ` +
            `"${headers[headerNameDst.toLowerCase()][0].value}"`);
    }

    //Set new headers
    headers['x-frame-options'] = [{key: 'X-Frame-Options', value: 'DENY'}];
    headers['x-xss-protection'] = [{key: 'X-XSS-Protection', value: '1; mode=block'}];
    headers['content-security-policy'] = [{key: 'Content-Security-Policy', value: 'upgrade-insecure-requests'}];
    //headers['content-security-policy'] = [{key: 'Content-Security-Policy', value: "frame-ancestors 'self' *.googletagmanager.com"}];
    headers['strict-transport-security'] = [{key: 'Strict-Transport-Security', value: 'max-age=31536000; includesubdomains'}];
    headers['x-content-type-options'] = [{key: 'X-Content-Type-Options', value: 'nosniff'}];
    //headers['cache-control'] = [{key: 'Cache-Control', value: 'no-cache="Set-Cookie"'}];
    headers['cache-control'] = [{key: 'Cache-Control', value: 'no-cache,no-store,must-revalidate,pre-check=0,post-check=0'}];

    return response;
};
