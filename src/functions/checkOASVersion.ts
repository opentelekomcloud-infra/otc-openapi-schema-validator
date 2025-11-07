import { Diagnostic } from "@codemirror/lint";
import { mapSeverity } from "@/utils/mapSeverity";
import * as YAML from 'yaml';
import {getSource} from "@/functions/common";

export function checkOASVersion(spec: any, content: string, rule: any): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const allowed = rule.call.functionParams.allowedVersions || [];
    const doc = YAML.parseDocument(content);
    const openapiNode = doc.get('openapi');
    let rawVersion = spec?.openapi;

    if (openapiNode && YAML.isScalar(openapiNode)) {
        rawVersion = openapiNode.source;
    }
    const openapiKeyIndex = content.indexOf("openapi");

    if (rawVersion === undefined || rawVersion === null) {
        diagnostics.push({
            from: openapiKeyIndex >= 0 ? openapiKeyIndex : 0,
            to: openapiKeyIndex >= 0 ? openapiKeyIndex + 7 : content.length,
            severity: mapSeverity(rule.severity),
            message: `'${rule.message}' Missing 'openapi' field.`,
            source: getSource(rule),
        });
        return diagnostics;
    }

    const version = String(rawVersion);
    const majorMinor = version.match(/^(\d+\.\d+)/)?.[1];

    if (!majorMinor || !allowed.includes(majorMinor)) {
        const index = content.indexOf(version);
        diagnostics.push({
            from: index >= 0 ? index : openapiKeyIndex,
            to: index >= 0 ? index + version.length : content.length,
            severity: mapSeverity(rule.severity),
            message: `'${rule.message}' 'openapi' version '${version}' is not allowed.`,
            source: getSource(rule),
        });
    }

    return diagnostics;
}
