const { runScanForDomain } = require('./shopscanner2');

const target = process.argv[2];
if (!target) {
  console.log('Usage: node run-scanner.js <domain-or-url>');
  process.exit(1);
}

runScanForDomain(target)
  .then(result => {
    if (!result.success) {
      console.error(`Scan failed: ${result.error}`);
      process.exit(1);
    }
    console.log('---SCANNER_RESULTS_START---');
    console.log(JSON.stringify(result, null, 2));
    console.log('---SCANNER_RESULTS_END---');
  })
  .catch(error => {
    console.error(`Unexpected error: ${error.message}`);
    process.exit(1);
  });
