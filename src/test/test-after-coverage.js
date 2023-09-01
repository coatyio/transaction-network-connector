/*! Copyright (c) 2023 Siemens AG. Licensed under the MIT License. */

const lcovTotal = require("lcov-total");

/*
 * Log output is used by GitLab CI/CD to create a test coverage report badge in
 * README.md. The test coverage result is identified by the following regular
 * expression in re2 syntax (https://regex101.com/) which yields the last match
 * defined in the output. Using the 'coverage' keyword this expression is added
 * to the job "test_coverage" in the .gitlab-ci.yml file.
 *
 * coverage: '/^Total test coverage: (\d+\.\d+)%$/'
 */
let coverage = lcovTotal("./coverage/lcov.info").toFixed(2);
if (!coverage.includes(".")) {
    coverage += ".00";
}
console.log("Total test coverage: %s%", coverage);
