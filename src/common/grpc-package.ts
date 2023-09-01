/*! Copyright (c) 2023 Siemens AG. Licensed under the MIT License. */

import { GrpcObject, loadPackageDefinition, ServiceDefinition } from "@grpc/grpc-js";
import { fromJSON, Options } from "@grpc/proto-loader";
import { Root } from "protobufjs";

/**
 * Options for class GrpcPackage.
 */
// tslint:disable-next-line: no-empty-interface
export interface GrpcPackageOptions {
}

/**
 * Represents the Protobuf Any type.
 */
export type AnyType = { type_url: string, value: Uint8Array };

/**
 * Represents a gRPC package for use with the "@grpc/grpc-js" library.
 *
 * Includes convenience methods for packing/unpacking Any message objects.
 */
export class GrpcPackage {

    private static readonly GOOGLEAPI_TYPE_URL_PREFIX = "type.googleapis.com/";

    private readonly _options: GrpcPackageOptions;
    private readonly _grpcProtobufOptions: Options;
    private readonly _root: Root;
    private _grpcRoot: GrpcObject;

    /**
     * Create a gRPC package from the specified proto file(s).
     *
     * @param protoFile proto file(s) making up the gRPC package
     * @param options options that control operation of this instance (optional)
     */
    constructor(protoFile: string | string[], options?: GrpcPackageOptions) {
        this._options = options || {};
        // Note: the full set of Protobuf conversion options must be specified
        // wherever requested, otherwise all defaults are used.
        // Conversion options are conforming to the standard behavior of
        // Protocol Buffers regarding encoding/decoding of default values for
        // scalar and non-scalar message fields.
        this._grpcProtobufOptions = {
            keepCase: false,

            // Use default conversion to Long with long library. No need to
            // import long library in this project as long values are not
            // manipulated explicitly.
            longs: undefined,

            enums: Number,

            // Use default conversion, i.e. Buffer in Node.js, Uint8Array in browser.
            bytes: undefined,

            // Output default values for omitted fields.
            // Note: null is the default value for omitted message fields.
            defaults: true,

            // Set empty arrays for omitted repeated fields.
            arrays: true,

            objects: false,
            oneofs: false,

            // If true, represent Infinity and NaN as strings in float fields. Also unpack
            // google.protobuf.Any automatically if Protobuf definition exists for its type,
            // i.e. return decoded JSON representation of Any object { "@type":
            // "<type_url>", field1: value1, ... } instead of returning undecoded Any object
            // { type_url: "...", value: Buffer<...> }.
            json: false,

            includeDirs: [],
        };
        this._root = new Root(this._grpcProtobufOptions);
        this._root.loadSync(protoFile, this._grpcProtobufOptions);
        this._root.resolveAll();
        this._grpcRoot = loadPackageDefinition(fromJSON(this._root.toJSON({ keepComments: false }), this._grpcProtobufOptions));
    }

    /**
     * Gets the options specified in the ctor of this class (with defaults
     * filled in).
     */
    get options(): Readonly<GrpcPackageOptions> {
        return this._options;
    }

    /**
     * Represents the gRPC root object of the object hierarchy loaded from the
     * proto files specified on initialization.
     */
    get grpcRoot(): Readonly<GrpcObject> {
        return this._grpcRoot;
    }

    /**
     * Gets the gRPC service definition for the given gRPC service name.
     *
     * @param serviceName fully qualified name of service with package prefix,
     * e.g. "flowpro.tnc.coaty.CommunicationService"
     * @returns service definition object
     */
    getServiceDefinition(serviceName: string) {
        return serviceName.split(".").reduce((o, p) => o[p], this._grpcRoot)["service"] as ServiceDefinition;
    }

    /**
     * Packs the specified plain object of the given Protobuf message type into
     * an Any message using the given type URL prefix.
     *
     * The type URL will be constructed by concatenating the message type's full
     * name to the prefix with an optional "/" separator if the prefix doesn't
     * end with "/" already. If a type URL prefix is not specified, the prefix
     * "type.googleapis.com/" is used.
     *
     * @param object a plain object to be packed
     * @param typeName fully qualified name of message type of given object to
     * be packed
     * @param typeUrlPrefix prefix of type URL for Any message (optional)
     * @returns packed object in Any representation
     * @throws if encoding the given object fails
     */
    pack(object: { [field: string]: any }, typeName: string, typeUrlPrefix?: string): AnyType {
        const objectType = this._root.lookupType(typeName);
        if (!objectType) {
            throw new TypeError("Cannot pack as given type name is not an existing Protobuf definition");
        }
        if (typeUrlPrefix && !typeUrlPrefix.endsWith("/")) {
            typeUrlPrefix += "/";
        }
        return {
            type_url: (typeUrlPrefix || GrpcPackage.GOOGLEAPI_TYPE_URL_PREFIX) + typeName,
            value: objectType.encode(objectType.fromObject(object)).finish(),
        };
    }

    /**
     * Unpacks this Any object into a plain object. If a type name is given it
     * must match the full type name in the type URL of the given Any object.
     *
     * @param anyObject a packed object in Any representation
     * @param typeName fully qualified type name of expected message type
     * (optional)
     * @returns unpacked plain object
     * @throws if given type name doesn't match the full type name in the type
     * URL of the Any object, or if decoding of the given object fails
     */
    unpack(anyObject: AnyType, typeName?: string): { [field: string]: any } {
        if (anyObject === null) {
            throw new TypeError("Cannot unpack as null is not compatible with Any type");
        }
        const anyTypeUrl = anyObject["type_url"];
        const anyValue = anyObject["value"];
        if (!anyTypeUrl || !(anyValue instanceof Uint8Array)) {
            throw new TypeError("Cannot unpack as given object is not compatible with Any type");
        }
        const sep = anyTypeUrl.lastIndexOf("/") + 1;
        const name = anyTypeUrl.substring(sep);
        if (typeName !== undefined && typeName !== name) {
            throw new TypeError(`Packed Any type_url ${anyTypeUrl} doesn't match type ${typeName}`);
        }
        const objectType = this._root.lookupType(name);
        return objectType.toObject(objectType.decode(anyValue), this._grpcProtobufOptions);
    }

    /**
     * Gets the type URL of the given Any object.
     *
     * @param anyObject an object in Any representation
     * @returns type URL of the given Any object
     * @throws if object is not of type Any
     */
    getAnyTypeUrl(anyObject: AnyType) {
        const anyTypeUrl = anyObject["type_url"];
        if (!anyTypeUrl || !(anyObject["value"] instanceof Uint8Array)) {
            throw new TypeError("Cannot getAnyTypeName as given object is not compatible with Any type");
        }
        return anyTypeUrl;
    }

    /**
     * Gets the fully qualified type name of the given Any object.
     *
     * @param anyObject an object in Any representation
     * @returns fully qualified type name of the given Any object
     * @throws if object is not of type Any
     */
    getAnyTypeName(anyObject: AnyType) {
        const anyTypeUrl = anyObject["type_url"];
        if (!anyTypeUrl || !(anyObject["value"] instanceof Uint8Array)) {
            throw new TypeError("Cannot getAnyTypeName as given object is not compatible with Any type");
        }
        const sep = anyTypeUrl.lastIndexOf("/") + 1;
        return anyTypeUrl.substring(sep);
    }
}
