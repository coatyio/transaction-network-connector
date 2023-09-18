# Developer Notes

## Testing

```sh
npm install
npm run build

# Run test suite without any Logger messages.
npm run test

# Run test suite with Logger messages except for log level INFO.
npm run test:detail

# Run test suite with Debug output for all tnc.* modules.
npm run test:debug

# Run test suite and create coverage information in folder coverage.
npm run test:coverage
```

## Release new version

To release a new version of this package, run `npm run release`. This includes
automatic version bumping, building, creation of documentation and a deployment
bundle, generation of a conventional changelog based on git commit history, git
tagging, and pushing the release on
[GitHub](https://github.com/coatyio/transaction-network-connector). For a dry
test run, invoke `npm run release:dry`.

Whenever a version-tagged commit is pushed, a Docker image, a Deployment Bundle,
and executables of the TN Connector are automatically build by GitHub Actions.
Deployment bundle and executables are attached to the created GitHub release as
zipped assets.

The Docker image is pushed to the GitHub Container registry of the
`transaction-network-connector` repo. You can inspect a released image
interactively as follows (can't use bash shell as it is not part of
alpine-linux):

```sh
docker run -it --rm -p 50060:50060 ghcr.io/coatyio/transaction-network-connector:<release-version> ash 
```

## Testing executables

To create and test platform-specific executables generated with the
[pkg](https://github.com/vercel/pkg) tool, run `npm run pkg` from the project
folder. The generated binaries are saved in the `dist-binaries` folder.

> **NOTE**: The parameters for packaging are defined in `package.json` under the
> key "pkg".

To test the binaries from within the project folder:

```sh
# Run Windows x64 binary on a Windows host
> dist-binaries\tnc-win.exe

# Run Linux x64 binary in Ubuntu container on Windows host
> docker run --rm -it -v %CD%:/opt ubuntu bash
root@430c96fb3bc0:/# cd opt/
root@430c96fb3bc0:/opt# dist-binaries/tnc-linux
```

> **Note**: Put a `.env` file alongside the executable to apply its environment
> variable settings to the executing TN Connector.

## Testing Docker image

For testing and debugging purposes you can build a Docker image locally and run
it as follows:

```sh
npm run build
npm run deploy
docker build -t tn-connector-local:latest .
docker run --rm -p 50060:50060 tn-connector-local:latest
```

## Broker for testing Coaty communication

You can use the integrated Coaty MQTT broker for development and testing
purposes. Just run `npm run broker`.

## Node.js compatibility

Due to a bug in http2 module of Node.js v14 the TN Connector and its dependency
`@grpc/grpc-js` should only run in a Node.js runtime version 12 or 16+. For
details, see `engines` restriction in `package.json`.

## License

Code and documentation copyright 2023 Siemens AG.

Code is licensed under the [MIT License](https://opensource.org/licenses/MIT).

Documentation is licensed under a
[Creative Commons Attribution-ShareAlike 4.0 International License](http://creativecommons.org/licenses/by-sa/4.0/).
