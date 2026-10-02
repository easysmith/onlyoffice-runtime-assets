import { parseAssetRoot, verifyOfficeFonts } from './office-font-artifacts.mjs';

verifyOfficeFonts({ assetRoot: parseAssetRoot(process.argv.slice(2)) })
  .then(result => console.log(`[office-fonts] ${JSON.stringify(result)}`))
  .catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
