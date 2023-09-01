/*! Copyright (c) 2023 Siemens AG. Licensed under the MIT License. */

const glob = require("fast-glob");

module.exports = testFile => {
    return glob.sync([
        "dist/**/*.js",

        // Exclude test utility functions from coverage.
        "!dist/test/**/*.js",
    ]);
};
