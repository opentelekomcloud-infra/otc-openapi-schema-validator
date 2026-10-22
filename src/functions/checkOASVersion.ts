import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import * as YAML from 'yaml';
import {getSource} from "@/functions/common";

export function checkOASVersion(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const allowed = rule.call.functionParams.allowedVersions || [];
    const hasOpenapi = spec?.openapi !== undefined;
    const hasSwagger = spec?.swagger !== undefined;

    if (hasOpenapi && hasSwagger) {
        return [{
            from: 0,
            to: content.length,
            severity: mapSeverity(rule.severity),
            message: `'${rule.message}' Define either 'swagger' or 'openapi', not both.`,
            source: getSource(rule),
        }];
    }

    const versionKey = hasSwagger ? "swagger" : "openapi";
    const doc = YAML.parseDocument(content);
    const versionNode = doc.get(versionKey, true);
    let rawVersion = spec?.[versionKey];

    if (YAML.isScalar(versionNode)) {
        rawVersion = versionNode.source ?? rawVersion;
    }
    const versionKeyIndex = content.indexOf(versionKey);

    if (rawVersion === undefined || rawVersion === null) {
        diagnostics.push({
            from: versionKeyIndex >= 0 ? versionKeyIndex : 0,
            to: versionKeyIndex >= 0 ? versionKeyIndex + versionKey.length : content.length,
            severity: mapSeverity(rule.severity),
            message: `'${rule.message}' Missing 'swagger' or 'openapi' version field.`,
            source: getSource(rule),
        });
        return diagnostics;
    }

    const version = String(rawVersion);
    const majorMinor = version.match(/^(\d+\.\d+)(?:\.\d+)?$/)?.[1];
    const isScalarVersion = typeof spec?.[versionKey] === "string" || typeof spec?.[versionKey] === "number";
    const formatMatches = isScalarVersion && (versionKey === "swagger"
        ? version === "2.0" || (typeof spec.swagger === "number" && spec.swagger === 2)
        : majorMinor?.startsWith("3."));
    const allowedVersion = versionKey === "swagger" && formatMatches ? "2.0" : majorMinor;

    if (!formatMatches || !allowedVersion || !allowed.includes(allowedVersion)) {
        const index = content.indexOf(version);
        diagnostics.push({
            from: index >= 0 ? index : Math.max(0, versionKeyIndex),
            to: index >= 0 ? index + version.length : content.length,
            severity: mapSeverity(rule.severity),
            message: `'${rule.message}' '${versionKey}' version '${version}' is not allowed.`,
            source: getSource(rule),
        });
    }

    return diagnostics;
}
