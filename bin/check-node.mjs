const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 26 || major === 26 && minor < 4) {
  console.error(`Litespeed requires Node.js 26.4 or later. You are running ${process.version}.
Install Node.js 26.4+ from https://nodejs.org/en/download, then reopen your terminal.
Check node --version, then rerun npm ci and npm run build in the Litespeed checkout.`);
  process.exit(1);
}
