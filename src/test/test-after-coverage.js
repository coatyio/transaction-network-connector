/*! Copyright (c) 2023 Siemens AG. Licensed under the MIT License. */

const fs = require("fs");
const lcov2badge = require("lcov2badge");

/*
 * Creates an SVG coverage badge file stored in the coverage folder.
 * This folder is copied to GitHub Pages by a GitHub release action
 * and can be referenced in the README.md.
 */
lcov2badge.badge("./coverage/lcov.info", function (err, svgBadge) {
    if (err) throw err;
    fs.writeFileSync("./coverage/lcov-badge.svg", svgBadge);
});
