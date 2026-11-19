"use client";

import React, { useEffect, useRef, useState } from "react";
import { parseApiExclusions, validateExclusionRuleIds, type ApiExclusions } from "@/lib/linter/issueExclusions";
import type { AutoRule } from "@/lib/linter/ruleCatalog";

type Props = {
    loadRules: (ruleset: string) => Promise<AutoRule[]>;
    onImport: (exclusions: ApiExclusions, rules: AutoRule[]) => void;
};

export default function ExclusionsImport({ loadRules, onImport }: Props) {
    const [json, setJson] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);
    const readerRef = useRef<FileReader | null>(null);
    const operationRef = useRef(0);
    useEffect(() => () => {
        operationRef.current += 1;
        readerRef.current?.abort();
    }, []);

    const loadFile = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (!file) return;
        const operation = ++operationRef.current;
        readerRef.current?.abort();
        setJson("");
        setError("");
        setBusy(true);
        const reader = new FileReader();
        readerRef.current = reader;
        const isCurrent = () => operationRef.current === operation;
        reader.onload = () => {
            if (!isCurrent()) return;
            if (typeof reader.result === "string") setJson(reader.result);
            else setError("Unable to read the selected JSON file as text.");
        };
        reader.onerror = () => { if (isCurrent()) setError("Unable to read the selected JSON file."); };
        reader.onabort = () => { if (isCurrent()) setError("Reading the selected JSON file was aborted."); };
        reader.onloadend = () => {
            if (readerRef.current === reader) readerRef.current = null;
            if (isCurrent()) setBusy(false);
        };
        try {
            reader.readAsText(file);
        } catch (failure: unknown) {
            readerRef.current = null;
            setBusy(false);
            setError(`Unable to read the selected JSON file: ${failure instanceof Error ? failure.message : String(failure)}`);
        }
    };
    const apply = async () => {
        if (busy) return;
        const operation = ++operationRef.current;
        setError("");
        setBusy(true);
        try {
            const exclusions = parseApiExclusions(json);
            const rules = await loadRules(exclusions.ruleset);
            validateExclusionRuleIds(exclusions, rules);
            if (operationRef.current === operation) onImport(exclusions, rules);
        } catch (failure: unknown) {
            if (operationRef.current === operation) {
                setError(`Unable to import exclusions: ${failure instanceof Error ? failure.message : String(failure)}`);
            }
        } finally {
            if (operationRef.current === operation) setBusy(false);
        }
    };
    return <>
        <p>Paste API exclusions JSON or load a JSON file. Import replaces the current ruleset, automatic rule selection,
            and muted issues. All automatic rules not listed in exclude_auto_rules will be selected, including optional rules.
            Manual checks are unchanged.</p>
        <p className="muted">Load the specification first. Only rule/line pairs matching findings in the current
            specification will be muted; other pairs are ignored. Muted issues reset when the specification text
            or ruleset changes, or a specification file is loaded.</p>
        <textarea className="exclusionsJson" aria-label="Import API exclusions JSON" value={json} rows={12}
            disabled={busy} onChange={(event) => { setJson(event.target.value); setError(""); }}
            placeholder={'{\n  "ruleset": "default",\n  "exclude_auto_rules": [],\n  "exclude_issues": []\n}'} />
        <div className="inlineActions">
            <scale-button variant="secondary" disabled={busy} onClick={() => inputRef.current?.click()}>Load JSON file</scale-button>
            <input ref={inputRef} type="file" accept=".json,application/json" className="visuallyHidden"
                aria-label="Load API exclusions file" disabled={busy} onChange={loadFile} />
            <scale-button disabled={busy || !json.trim()} onClick={apply}>Import exclusions</scale-button>
        </div>
        {busy && <p role="status">Reading and validating exclusions...</p>}
        {error && <p role="alert">{error}</p>}
    </>;
}
