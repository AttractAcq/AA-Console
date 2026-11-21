# Video Lambda release candidate

This source-only change prepares the pinned Remotion Lambda release for the
manual video path. It does not deploy a site, create an AWS function, set
Railway variables or enable the video agent.

From a clean, reviewed checkout at the intended full commit SHA:

```sh
cd video-render
npm ci
npm test
npm run build
REMOTION_AWS_REGION=eu-west-1 npm run deploy:lambda -- --expected-sha=<full-reviewed-sha>
```

The command above prints a read-only plan. After the Remotion licence and AWS
account/region are confirmed, the authorized release operator sets
`AA_REMOTION_LICENSE_CONFIRMED=1` and `AA_REMOTION_LICENSE_BASIS` to either
`free-up-to-three` or `company-automators`, then appends `--execute`. The
basis and its evidence are described in [LICENSE-NOTE.md](../video-render/LICENSE-NOTE.md).
The script requires a clean checkout and exact SHA, deploys the version-pinned
function and immutable SHA-named site, reads the function configuration back,
and checks for `VideoThumbnail` and all three `VideoIR` compositions. Only a
successful read-back prints `REMOTION_FUNCTION_NAME` and `REMOTION_SERVE_URL`
values for the separate Railway configuration step. The renderer agent stays
paused until the real provider and operator acceptance checks pass.

The site URL is public because the Lambda browser must load it. Put no
credentials or customer data in the renderer bundle. Media and customer input
remain in the runtime's private Storage flow. If the script fails after site
creation, inspect the named function/site and release receipt before retrying;
the SHA-named site is configured to reject an overwrite.

The script follows Remotion's [function deployment](https://www.remotion.dev/docs/lambda/deployfunction),
[site deployment](https://www.remotion.dev/docs/lambda/deploysite), and
[composition read-back](https://www.remotion.dev/docs/lambda/getcompositionsonlambda)
contracts for pinned package version 4.0.545.
