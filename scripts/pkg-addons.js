/*! Copyright (c) 2023 Siemens AG. Licensed under the MIT License. */

/*
 * Utility script to make target-specific node addons located in folder
 * node-addons available to the pkg tool for bundling. This script must be
 * executed before running pkg tool so that pkg can integrate the node addons as
 * assets (see package.json property "pkg.assets").
 *
 * Note that all addons located under folder node-addons are bundled into each
 * packaged binary. At run time, the appropriate addon for the binary's given
 * target platform and architecture is loaded.
 */

const fs = require("fs-extra");
const glob = require("fast-glob");
const path = require("path");

function copyNodeAddons() {
    const addons = "node-addons";
    for (const src of glob.sync("**/*.node", { cwd: addons })) {
        const dst = path.join("node_modules", src);
        fs.ensureDirSync(path.dirname(dst));
        fs.copyFileSync(path.join(addons, src), dst);
        console.log(`Installing node addon into ${dst}`);
    }
}

copyNodeAddons();
