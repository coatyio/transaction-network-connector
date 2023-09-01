/*! Copyright (c) 2023 Siemens AG. Licensed under the MIT License. */

const fsextra = require("fs-extra");
const fancyLog = require("fancy-log");
const gulp = require("gulp");
const chmod = require("gulp-chmod");
const filter = require('gulp-filter');
const jeditor = require("gulp-json-editor");
const tsc = require("gulp-typescript");
const tslint = require("gulp-tslint");
const zip = require("gulp-zip");
const infoAgentScript = require("@coaty/core/scripts/info");

/**
 * Clean distribution folder
 */
gulp.task("clean", () => {
    return fsextra.emptyDir("dist");
});

/**
 * Generate Agent Info
 */
gulp.task("agentinfo", infoAgentScript.gulpBuildAgentInfo("./src/", "agent.info.ts"));

/**
 * Transpile TS into JS code, using TS compiler in local typescript npm package.
 * Remove all comments except copyright header comments, and do not generate
 * corresponding .d.ts files (see task "transpile:dts").
 */
gulp.task("transpile:ts", () => {
    const tscConfig = require("./tsconfig.json");
    return gulp
        .src(["src/**/*.ts"])
        .pipe(tsc(Object.assign(tscConfig.compilerOptions, {
            removeComments: true,
            declaration: false,
        })))
        .pipe(gulp.dest("dist"));
});

/**
 * Only emit TS declaration files, using TS compiler in local typescript npm
 * package. The generated declaration files include all comments so that IDEs
 * can provide this information to developers.
 */
gulp.task("transpile:dts", () => {
    const tscConfig = require("./tsconfig.json");
    return gulp
        .src(["src/**/*.ts"])
        .pipe(tsc(Object.assign(tscConfig.compilerOptions, {
            removeComments: false,
            declaration: true,
        })))
        .dts
        .pipe(gulp.dest("dist"));
});

/**
* Copy Javascript files (not transpiled)
*/
gulp.task("copy:js", () => {
    return gulp
        .src(["src/**/*.js", "src/**/*.mjs"])
        .pipe(gulp.dest("dist"));
});

/**
 * Protobuf definitions required at runtime
 */
gulp.task("copy:proto", () => {
    return gulp
        .src([
            "src/prot{o..o}/**/*",
            "src/tes{t..t}/proto/**/*",
        ])
        .pipe(gulp.dest("dist"));
});

/**
 * Lint the application
 */
gulp.task("lint", () => {
    return gulp.src(["src/**/*.ts"])
        .pipe(tslint({
            configuration: "./tslint.json",
            formatter: "verbose",
        }))
        .pipe(tslint.report({
            emitError: false,
            summarizeFailureOutput: true
        }));
});

/**
 * Lint the application and fix lint errors
 */
gulp.task("lint:fix", () => {
    return gulp.src(["src/**/*.ts"])
        .pipe(tslint({
            configuration: "./tslint.json",
            formatter: "verbose",
            fix: true
        }))
        .pipe(tslint.report({
            emitError: false,
            summarizeFailureOutput: true
        }));
});;

/**
 * Create a deployment bundle for the current package version.
 */
gulp.task("deploy", () => {
    const zipFile = `${process.env.npm_package_name.split("/").reverse()[0]}.zip`;
    const zipFolder = "./deploy";
    const pkgFilter = filter(["package.json"], { restore: true });
    const pkgModifier = pkg => {
        pkg.scripts = {
            "start": pkg.scripts["start"],
        };
        delete pkg["devDependencies"];
        return pkg;
    };

    return gulp.src([
        "README.md",
        "HOWTO.md",
        "LICENSE",
        "package.json",
        "package-lock.json",
        ".env",
        ".npmrc",

        // Specify pattern in directory to preserve subfolder structure.
        "dis{t..t}/**/*",
        "!dis{t..t}/test",
        "!dis{t..t}/test/**/*",
        "!dis{t..t}/**/*.d.ts"],
        { cwd: "." })
        .pipe(pkgFilter)
        .pipe(jeditor(pkgModifier))
        .pipe(pkgFilter.restore)
        .pipe(chmod(undefined, { execute: true }))
        .pipe(zip(zipFile, { modifiedTime: new Date() }))
        .pipe(gulp.dest(zipFolder))
        .on("finish", () => fancyLog(`Created deployment bundle ${zipFolder}/${zipFile}`));
});

gulp.task("build", gulp.series(
    "clean",
    "agentinfo",
    "transpile:ts",
    "transpile:dts",
    "copy:js",
    "copy:proto",
    "lint"));

gulp.task("default", gulp.series("build"));
