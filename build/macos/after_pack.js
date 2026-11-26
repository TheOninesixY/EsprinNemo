const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ARCH_LABELS = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

module.exports = async function afterPack(context) {
  if (!context || context.electronPlatformName !== 'darwin') return;
  if (process.platform !== 'darwin') return;

  const appOutDir = String(context.appOutDir || '');
  if (/-temp$/.test(appOutDir)) return;

  const productFilename = context.packager && context.packager.appInfo
    ? context.packager.appInfo.productFilename
    : 'EsprinNemo';
  const appPath = path.join(appOutDir, `${productFilename}.app`);
  if (!fs.existsSync(appPath)) return;

  const archLabel = ARCH_LABELS[context.arch] || String(context.arch);

  try {
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
    console.log(`[Desktop:INFO] 已对 ${productFilename}.app 做 ad-hoc 签名（${archLabel}）`);
  } catch (error) {
    console.error(`[Desktop:ERROR] ad-hoc 签名失败（${archLabel}）：${error.message}`);
    throw error;
  }
};
