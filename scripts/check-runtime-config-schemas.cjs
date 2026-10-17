// Use the same package discovery/schema loader as Backstage's root logger.
// Run after extracting the production bundle, without loading secrets/config.
const { createRequire } = require('node:module');
const path = require('node:path');
const runtimeRequire = createRequire(
  require.resolve('@backstage/backend-defaults', {
    paths: [path.resolve('packages/backend')],
  }),
);

async function main() {
  const { getPackages } = runtimeRequire('@manypkg/get-packages');
  const { loadConfigSchema } = runtimeRequire('@backstage/config-loader');
  const { packages } = await getPackages(process.cwd());
  if (!packages.length)
    throw new Error('No production workspace packages found');
  await loadConfigSchema({
    dependencies: packages.map(p => p.packageJson.name),
  });
  console.log(
    `Production config schemas loaded for ${packages.length} workspaces`,
  );
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
