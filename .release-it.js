/*! Copyright (c) 2023 Siemens AG. Licensed under the MIT License. */

const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readlineSync = require("readline-sync");
const replaceInFile = require("replace-in-file");

const releaseNotesFile = path.join(os.tmpdir(), "tn-connector-relnotes.txt");
const changelogFile = "CHANGELOG.md";
const readmeFile = "README.md";

/**
 * Invoked by npm run scripts.
 *
 * Prompt the user to enter release notes which are embedded into the
 * conventional changelog entry in the process of running release-it afterwards.
 */
function promptReleaseNotes() {
    const lines = [];
    let i = 1;
    let line;

    readlineSync.setDefaultOptions({ keepWhitespace: true });
    console.log("Enter release notes (line by line, to finish press ENTER key only)");
    while (line = readlineSync.question(`Line ${i++}: `)) {
        lines.push(line);
    }
    console.log("...");

    if (lines.length > 0) {
        fs.writeFileSync(releaseNotesFile, lines.join("\n"), "utf-8");
    }
}

/**
 * A release-it "before:release" hook function to augment Changelog and Readme
 * files with release information.
 */
function augmentChangelogAndReadme() {
    const [version, latestVersion, isCi] = process.argv.slice(1);
    augmentChangelog(version, latestVersion, isCi);
    augmentReadme(version, latestVersion, isCi);
}

/**
 * After generating the conventional changelog file for the current release,
 * insert release notes between the release header and the commit messages.
 * Additionally, ensure the Changelog title is moved/added to the beginning of
 * the file and remove any duplicate version of the new release.
 */
function augmentChangelog(version, latestVersion, isCi) {
    // Enforce uniform line endings.
    const readLines = file => fs.readFileSync(file, "utf-8").replace(/\r\n/g, "\n").split("\n");
    const findLineIndex = (regexp, allLines, startIndex) => {
        const len = allLines.length;
        for (let i = startIndex || 0; i < len; i++) {
            if (regexp.test(allLines[i])) {
                return i;
            }
        }
        return undefined;
    };
    const escapeRegex = s => s.replace(/[.*+\-?^${}()|[\]\\]/g, "\\$&");
    const releaseRegex = version => {
        const versionRegex = escapeRegex(version);
        const urlRegex = "\\S+";
        return new RegExp(`^##? (${versionRegex})|(\\[${versionRegex}\\]\\(${urlRegex}\\)) \\(\\d\\d\\d\\d-\\d\\d-\\d\\d\\)$`);
    };
    const anyReleaseRegex = /^##? (\S+)|(\[\S+\]\(\S+\)) \(\d\d\d\d-\d\d-\d\d\)$/;

    let relNotes;

    // Use the prompted release notes in a non-CI environment. In a CI
    // environment, the release notes file could have been generated by a tool.
    try {
        relNotes = readLines(releaseNotesFile);
        fs.unlinkSync(releaseNotesFile);
    } catch { }

    const lines = readLines(changelogFile);

    // Move/add changelog title to the top.
    const titleLine = "# Changelog";
    const titleRegex = new RegExp(`^${escapeRegex(titleLine)}$`);
    const indexTitle = findLineIndex(titleRegex, lines);
    if (indexTitle !== undefined) {
        lines.unshift(...lines.splice(indexTitle, 2));
    } else {
        lines.unshift(titleLine, "");
    }

    const indexVersion = findLineIndex(releaseRegex(version), lines);

    // Remove latest release version if it equals the new release.
    if (version === latestVersion) {
        const indexLatestVersion = findLineIndex(releaseRegex(latestVersion), lines, indexVersion + 1);
        if (indexLatestVersion !== undefined) {
            let indexNext = findLineIndex(anyReleaseRegex, lines, indexLatestVersion + 1);
            if (indexNext === undefined) {
                indexNext = lines.length;
            }
            lines.splice(indexLatestVersion, indexNext - indexLatestVersion);
        }
    }

    // Insert release notes if given.
    if (relNotes && relNotes.length > 0) {
        lines.splice(indexVersion + 2, 0, ...relNotes);
    }

    fs.writeFileSync(changelogFile, lines.join("\n"), "utf-8");

    // Stage the modified file again.
    execSync(`git add ${changelogFile}`);
}

function augmentReadme(version, latestVersion, isCi) {
    replaceInFile.sync({
        files: readmeFile,
        from: [/badges\/v\d+\.\d+\.\d+\/coverage/, /badges\/v\d+\.\d+\.\d+\/pipeline/],
        to: [`badges/v${version}/coverage`, `badges/v${version}/pipeline`]
    });

    // Stage the modified file again.
    execSync(`git add ${readmeFile}`);
}

module.exports = {

    // Invoked by npm run scripts before running release-it to prompt the user
    // for entering release notes.
    promptReleaseNotes,

    // Invoked by release-it in the "before:release" hook to augment the
    // changelog that has been generated.
    augmentChangelogAndReadme,

    // release-it options
    "git": {
        "requireCleanWorkingDir": false,
        "push": true,
        "requireCommits": true,
        "addUntrackedFiles": true,
        "commitMessage": "chore: release v${version}",
        "commitArgs": [
            "--no-verify"
        ],
        "tagName": "v${version}",
        "tagAnnotation": "chore: release v${version}",
        "tagArgs": [
            "--force"
        ],
        "requireUpstream": false
    },
    "github": {
        "release": false
    },
    "gitlab": {
        "release": false
    },
    "npm": {
        "publish": false,
    },
    "hooks": {
        "before:release": "node -e \"require('./.release-it.js').augmentChangelogAndReadme()\" \"${version}\" \"${latestVersion}\" \"${ci}\" && npm run _release:before && git add --all :/",
    },
    "plugins": {
        "@release-it/conventional-changelog": {
            "preset": "angular",
            "infile": changelogFile
        }
    },
};
