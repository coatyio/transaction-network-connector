/*! Copyright (c) 2023 Siemens AG. Licensed under the MIT License. */

import * as tap from "tap";

import { initTestContext } from "../test-context";
import { getGrpcTestPackage } from "../test-grpc";

initTestContext(tap);

tap.test("GrpcPackage", t => {
    const pkg = getGrpcTestPackage(t, ["tnc_test.proto"]);

    t.test("options", ts => {
        ts.strictSame(pkg.options, {});
        ts.end();
    });

    t.test("service definitions", ts => {
        ts.equal(Object.keys(pkg.getServiceDefinition("flowpro.tnc.icc.RoutingService")).length, 5);
        ts.ok("RegisterPushRoute" in pkg.getServiceDefinition("flowpro.tnc.icc.RoutingService"));
        ts.ok("RegisterRequestRoute" in pkg.getServiceDefinition("flowpro.tnc.icc.RoutingService"));
        ts.ok("Push" in pkg.getServiceDefinition("flowpro.tnc.icc.RoutingService"));
        ts.ok("Request" in pkg.getServiceDefinition("flowpro.tnc.icc.RoutingService"));
        ts.ok("Respond" in pkg.getServiceDefinition("flowpro.tnc.icc.RoutingService"));

        ts.equal(Object.keys(pkg.getServiceDefinition("flowpro.tnc.coaty.CommunicationService")).length, 7);
        ts.ok("Configure" in pkg.getServiceDefinition("flowpro.tnc.coaty.CommunicationService"));
        ts.ok("PublishChannel" in pkg.getServiceDefinition("flowpro.tnc.coaty.CommunicationService"));
        ts.ok("ObserveChannel" in pkg.getServiceDefinition("flowpro.tnc.coaty.CommunicationService"));
        ts.ok("PublishCall" in pkg.getServiceDefinition("flowpro.tnc.coaty.CommunicationService"));
        ts.ok("ObserveCall" in pkg.getServiceDefinition("flowpro.tnc.coaty.CommunicationService"));
        ts.ok("PublishReturn" in pkg.getServiceDefinition("flowpro.tnc.coaty.CommunicationService"));
        ts.ok("PublishComplete" in pkg.getServiceDefinition("flowpro.tnc.coaty.CommunicationService"));

        ts.end();
    });

    t.test("pack - unpack", ts => {
        const object = { seqId: 1, value: 42 };
        const packed = pkg.pack(object, "flowpro.tnc.test.PushData");
        ts.equal(packed.type_url, "type.googleapis.com/flowpro.tnc.test.PushData");
        ts.ok(packed.value instanceof Uint8Array);

        const unpacked1 = pkg.unpack(packed);
        ts.strictSame(unpacked1, object);

        const unpacked2 = pkg.unpack(packed);
        ts.strictSame(unpacked2, object);

        ts.not(unpacked1, unpacked2);

        ts.end();
    });

    t.test("pack - unpack with custom type URL prefix", ts => {
        const object = { seqId: 1, value: 42 };
        let packed = pkg.pack(object, "flowpro.tnc.test.PushData", "https://foo/bar");
        ts.equal(packed.type_url, "https://foo/bar/flowpro.tnc.test.PushData");
        ts.ok(packed.value instanceof Uint8Array);

        packed = pkg.pack(object, "flowpro.tnc.test.PushData", "https://foo/bar/");
        ts.equal(packed.type_url, "https://foo/bar/flowpro.tnc.test.PushData");
        ts.ok(packed.value instanceof Uint8Array);

        ts.end();
    });

    t.test("pack - with unknown type name", ts => {
        const object = { seqId: 1, value: 42 };
        ts.throws(() => pkg.pack(object, "flowpro.tnc.test.XXXData"));

        ts.end();
    });

    t.test("unpack with unexpected type URL error", ts => {
        const object = { seqId: 1, value: 42 };
        const packed = pkg.pack(object, "flowpro.tnc.test.PushData");
        packed.type_url += packed.type_url + "x";
        ts.throws(() => pkg.unpack(packed));

        ts.end();
    });

    t.test("unpack with unexpected type name error", ts => {
        const object = { seqId: 1, value: 42 };
        const packed = pkg.pack(object, "flowpro.tnc.test.PushData");
        ts.throws(() => pkg.unpack(packed, "flowpro.tnc.test.ArithmeticOperands"));

        ts.end();
    });

    t.test("unpack - for non-Any object", ts => {
        const object = { seqId: 1, value: 42 };
        ts.throws(() => pkg.unpack(object as any));

        ts.end();
    });

    t.test("getAnyTypeUrl", ts => {
        const object = { seqId: 1, value: 42 };
        const packed = pkg.pack(object, "flowpro.tnc.test.PushData");
        ts.equal(pkg.getAnyTypeUrl(packed), "type.googleapis.com/flowpro.tnc.test.PushData");

        ts.end();
    });

    t.test("getAnyTypeUrl - for non-Any object", ts => {
        const object = { seqId: 1, value: 42 };
        ts.throws(() => pkg.getAnyTypeUrl(object as any));

        ts.end();
    });

    t.test("getAnyTypeName", ts => {
        const object = { seqId: 1, value: 42 };
        const packed = pkg.pack(object, "flowpro.tnc.test.PushData");
        ts.equal(pkg.getAnyTypeName(packed), "flowpro.tnc.test.PushData");

        ts.end();
    });

    t.test("getAnyTypeName - for non-Any object", ts => {
        const object = { seqId: 1, value: 42 };
        ts.throws(() => pkg.getAnyTypeName(object as any));

        ts.end();
    });

    t.end();
});
