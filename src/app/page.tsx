'use client';

import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import CodeMirror, { ExternalChange } from "@uiw/react-codemirror";
import { yaml } from "@codemirror/lang-yaml";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { linter, lintGutter, setDiagnostics as setEditorDiagnostics, type Diagnostic } from "@codemirror/lint";
import { openApiLinter } from "@/components/Linter";
import RulesetsSelector, { type Rule } from "@/components/RulesetsSelector";
import ManualChecksSelector, { type ManualRule } from "@/components/ManualChecksSelector";
import IssuesPanel, { type IssuesPanelHandle } from "@/components/IssuesPanel";
import { ScaleDialog } from "@/components/ScaleControls";
import { exportJUnit, exportPDF, exportReportPortal } from "@/utils/export";
import "@telekom/scale-components/dist/scale-components/scale-components.css";
import { applyPolyfills, defineCustomElements } from "@telekom/scale-components/loader";
import AuthButtons from "@/components/AuthButtons";

const initialCode = "// Start writing or load a file...";
type Tab = "issues" | "rules" | "manual";

const HomePage = () => {
    const [code, setCode] = useState(initialCode);
    const [fileName, setFileName] = useState("Untitled specification");
    const [showScrollButton, setShowScrollButton] = useState(false);
    const scrollRef = useRef<HTMLElement | null>(null);
    const editorViewRef = useRef<EditorView | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const fileReaderRef = useRef<FileReader | null>(null);
    const fileReadIdRef = useRef(0);
    const [sourceRevision, setSourceRevision] = useState(0);
    const [editorReady, setEditorReady] = useState(false);
    const [selectedRules, setSelectedRules] = useState<Rule[]>([]);
    const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
    const diagnosticsRef = useRef<readonly Diagnostic[]>([]);
    const issuesRef = useRef<IssuesPanelHandle>(null);
    const tabsRef = useRef<HTMLElement>(null);
    const [activeTab, setActiveTab] = useState<Tab>("issues");
    const [mobileView, setMobileView] = useState("results");
    const [isLinting, setIsLinting] = useState(false);
    const [lintError, setLintError] = useState<string | null>(null);
    const [manualRules, setManualRules] = useState<ManualRule[]>([]);
    const [showExportModal, setShowExportModal] = useState(false);
    const [specTitle, setSpecTitle] = useState<string | null>(null);
    const [isExporting, setIsExporting] = useState(false);
    const [totalAvailableRules, setTotalAvailableRules] = useState(0);
    const [rulesetName, setRulesetName] = useState("");
    const lintRunIdRef = useRef(0);
    const selectedManualRulesCount = manualRules.filter((rule) => rule.verified).length;
    const hasDocument = code !== initialCode && Boolean(code.trim());

    useEffect(() => { diagnosticsRef.current = diagnostics; }, [diagnostics]);
    useEffect(() => {
        const element = tabsRef.current;
        if (!element) return;
        const select = (event: Event) => {
            const tab = event.target instanceof HTMLElement ? event.target.dataset.tab : undefined;
            if (tab === "issues" || tab === "rules" || tab === "manual") setActiveTab(tab);
        };
        element.addEventListener("scale-select", select);
        return () => element.removeEventListener("scale-select", select);
    }, []);

    const lintDocument = useCallback(async (view: EditorView) => {
        const runId = ++lintRunIdRef.current;
        const document = view.state.doc;
        const isCurrent = () => lintRunIdRef.current === runId &&
            editorViewRef.current === view && view.state.doc === document;
        setDiagnostics([]);
        setSpecTitle(null);
        setLintError(null);
        setIsLinting(true);
        setShowExportModal(false);
        // An update listener cannot dispatch another transaction synchronously.
        queueMicrotask(() => {
            if (isCurrent()) view.dispatch(setEditorDiagnostics(view.state, []));
        });
        try {
            const result = await openApiLinter(selectedRules)(view);
            if (!isCurrent()) return;
            setSpecTitle(result.specTitle ?? null);
            setDiagnostics(result.diagnostics);
            view.dispatch(setEditorDiagnostics(view.state, result.diagnostics));
        } catch (error: unknown) {
            if (!isCurrent()) return;
            setLintError(`Unable to validate the specification: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            if (isCurrent()) setIsLinting(false);
        }
    }, [selectedRules]);

    const diagnosticsListenerExtension = useMemo(() => EditorView.updateListener.of((update) => {
        if (!update.docChanged || update.transactions.some((transaction) => transaction.annotation(ExternalChange))) return;
        void lintDocument(update.view);
    }), [lintDocument]);
    const gutterNavigation = useMemo(() => ViewPlugin.define((view) => {
        const click = (event: MouseEvent) => {
            if (!(event.target instanceof Element) || !event.target.closest(".cm-gutter-lint")) return;
            const block = view.lineBlockAtHeight(event.clientY - view.documentTop);
            const line = view.state.doc.lineAt(block.from).number;
            const diagnostic = diagnosticsRef.current.find((entry) => view.state.doc.lineAt(entry.from).number === line);
            if (diagnostic) {
                setActiveTab("issues");
                setMobileView("results");
                issuesRef.current?.reveal(diagnostic);
            }
        };
        // CodeMirror's gutter handles clicks outside contentDOM; observe before its tooltip handler.
        view.dom.addEventListener("click", click, true);
        return { destroy: () => view.dom.removeEventListener("click", click, true) };
    }), []);
    const codeMirrorExtensions = useMemo(
        () => [yaml(), linter(null), lintGutter(), diagnosticsListenerExtension, gutterNavigation],
        [diagnosticsListenerExtension, gutterNavigation],
    );
    useEffect(() => {
        applyPolyfills().then(() => defineCustomElements(window));
    }, []);
    useEffect(() => {
        if (editorReady && editorViewRef.current) void lintDocument(editorViewRef.current);
    }, [editorReady, lintDocument, sourceRevision]);

    const handleScroll = () => {
        if (scrollRef.current) setShowScrollButton(scrollRef.current.scrollTop > 50);
    };
    const handleEditorCreated = (view: EditorView) => {
        editorViewRef.current = view;
        scrollRef.current = view.scrollDOM;
        view.scrollDOM.addEventListener("scroll", handleScroll);
        setEditorReady(true);
    };
    useEffect(() => () => {
        lintRunIdRef.current += 1;
        fileReadIdRef.current += 1;
        fileReaderRef.current?.abort();
        scrollRef.current?.removeEventListener("scroll", handleScroll);
    }, []);

    const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
        const target = event.currentTarget;
        const file = target.files?.[0];
        target.value = "";
        if (!file) return;
        if (!file.name.endsWith(".yaml") && !file.name.endsWith(".yml")) {
            alert("Please upload a valid .yaml or .yml file.");
            return;
        }
        const readId = ++fileReadIdRef.current;
        fileReaderRef.current?.abort();
        const reader = new FileReader();
        fileReaderRef.current = reader;
        const isCurrent = () => fileReadIdRef.current === readId;
        reader.onload = () => {
            if (!isCurrent()) return;
            if (typeof reader.result !== "string") {
                alert("Unable to read the selected file as text.");
                return;
            }
            lintRunIdRef.current += 1;
            setDiagnostics([]);
            setSpecTitle(null);
            setLintError(null);
            setFileName(file.name);
            setCode(reader.result);
            setSourceRevision((revision) => revision + 1);
            setActiveTab("issues");
        };
        reader.onerror = () => { if (isCurrent()) alert("Unable to read the selected file."); };
        reader.onabort = () => { if (isCurrent()) alert("Reading the selected file was aborted."); };
        reader.onloadend = () => { if (fileReaderRef.current === reader) fileReaderRef.current = null; };
        try {
            reader.readAsText(file);
        } catch (error: unknown) {
            fileReaderRef.current = null;
            alert(`Unable to read the selected file: ${error instanceof Error ? error.message : String(error)}`);
        }
    };
    const handleSave = () => {
        const url = URL.createObjectURL(new Blob([code], { type: "text/yaml" }));
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "modified.yaml";
        anchor.click();
        URL.revokeObjectURL(url);
    };
    const handleSelectionChange = useCallback((selection: Rule[]) => {
        lintRunIdRef.current += 1;
        setSelectedRules(selection);
    }, []);
    const handleManualRulesChange = useCallback((rules: ManualRule[]) => setManualRules(rules), []);
    const handleDiagnosticClick = (diagnostic: Diagnostic) => {
        const view = editorViewRef.current;
        if (!view) return;
        const from = Math.max(0, Math.min(diagnostic.from, view.state.doc.length));
        setMobileView("editor");
        view.dispatch({ selection: { anchor: from }, effects: EditorView.scrollIntoView(from, { y: "center" }) });
        view.focus();
    };
    const handleExportReportPortal = async () => {
        setIsExporting(true);
        try {
            await exportReportPortal(diagnostics, selectedRules, manualRules, editorViewRef, {
                project: "openapi",
                launch: `Service: ${specTitle ?? "OpenAPI"}`,
                description: `Latest launch for ${specTitle ?? "OpenAPI"} - ${new Date().toISOString()}`,
                mode: "DEFAULT",
            });
            setShowExportModal(false);
            alert("Exported to ReportPortal successfully.");
        } catch (error: unknown) {
            console.error(error);
            alert(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setIsExporting(false);
        }
    };

    return <div className="validatorApp">
        <header className="appHeader">
            <div className="brandMark"><scale-logo variant="white" /></div>
            <div className="appTitle"><h1>OpenAPI Validator</h1><span>Specification workspace</span></div>
            <div className="headerActions">
                <scale-button onClick={() => fileInputRef.current?.click()} variant="primary">
                    <scale-icon-action-upload aria-hidden="true" />Load
                </scale-button>
                <input ref={fileInputRef} type="file" accept=".yaml,.yml" className="visuallyHidden"
                    aria-label="Load specification" onChange={handleFileUpload} />
                <scale-button onClick={handleSave} variant="secondary">
                    <scale-icon-action-download aria-hidden="true" />Save
                </scale-button>
                <scale-button onClick={() => {
                    if (!isLinting && !lintError) setShowExportModal(true);
                }} variant="secondary" disabled={isLinting || Boolean(lintError)}>
                    <scale-icon-action-export aria-hidden="true" />Export
                </scale-button>
                <AuthButtons />
            </div>
        </header>
        <div className="documentBar">
            <div className="documentIdentity"><strong>{fileName}</strong>{specTitle && <span>{specTitle}</span>}</div>
            <span className="muted">Ruleset: {rulesetName || "Not selected"} · Rules selected: {selectedRules.length}/{totalAvailableRules}</span>
            <scale-segmented-button className="mobileViewToggle" ariaLabelTranslation="Workspace view"
                selectedIndex={mobileView === "editor" ? 0 : 1}>
                <scale-segment selected={mobileView === "editor"} onClick={() => setMobileView("editor")}>Editor</scale-segment>
                <scale-segment selected={mobileView === "results"} onClick={() => setMobileView("results")}>Results</scale-segment>
            </scale-segmented-button>
        </div>
        <main className="workspace">
            <section id="source-pane" className="editorPane" aria-label="Specification editor" data-mobile-visible={mobileView === "editor"}>
                <div className="paneHeading"><h2>Source</h2><span className="muted">Original YAML · No conversion</span></div>
                <div className="editorSurface">
                    <CodeMirror value={code} height="100%" style={{ height: "100%" }} extensions={codeMirrorExtensions}
                        onChange={setCode} theme="light" basicSetup={{ lineNumbers: true, foldGutter: true }}
                        onCreateEditor={handleEditorCreated} />
                    {showScrollButton && <scale-button className="editorTop" variant="secondary" size="small"
                        onClick={() => scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" })}>Back to top</scale-button>}
                </div>
            </section>
            <section id="results-pane" className="resultsPane" aria-label="Validation workspace" data-mobile-visible={mobileView === "results"}>
                <scale-tab-nav ref={tabsRef} className="workspaceTabs" aria-label="Validation panels">
                    <scale-tab-header slot="tab" data-tab="issues" selected={activeTab === "issues"}
                        onClick={() => setActiveTab("issues")}>Issues ({diagnostics.length})</scale-tab-header>
                    <scale-tab-panel slot="panel" hidden={activeTab !== "issues"}>
                        <IssuesPanel ref={issuesRef} diagnostics={diagnostics}
                            content={editorViewRef.current?.state.doc.toString() ?? code}
                            isLinting={isLinting} lintError={lintError} hasDocument={hasDocument}
                            rulesSelected={selectedRules.length} onNavigate={handleDiagnosticClick}
                            onConfigureRules={() => setActiveTab("rules")} />
                    </scale-tab-panel>
                    <scale-tab-header slot="tab" data-tab="rules" selected={activeTab === "rules"}
                        onClick={() => setActiveTab("rules")}>Rules ({selectedRules.length}/{totalAvailableRules})</scale-tab-header>
                    <scale-tab-panel slot="panel" hidden={activeTab !== "rules"}>
                        <RulesetsSelector onSelectionChange={handleSelectionChange} onTotalRulesChange={setTotalAvailableRules}
                            onRulesetChange={setRulesetName} />
                    </scale-tab-panel>
                    <scale-tab-header slot="tab" data-tab="manual" selected={activeTab === "manual"}
                        onClick={() => setActiveTab("manual")}>Manual ({selectedManualRulesCount}/{manualRules.length})</scale-tab-header>
                    <scale-tab-panel slot="panel" hidden={activeTab !== "manual"}>
                        <ManualChecksSelector onManualRulesChange={handleManualRulesChange} />
                    </scale-tab-panel>
                </scale-tab-nav>
            </section>
        </main>
        <footer className="appFooter">
            © T-Systems International GmbH | 2026 EcoSystems | All rights reserved. |
            v{process.env.NEXT_PUBLIC_APP_VERSION ?? "dev"}
        </footer>
        {showExportModal && <ScaleDialog heading="Export" onClose={() => setShowExportModal(false)}>
            <p className="muted">Export all {diagnostics.length} issues and the current manual checklist. Display filters do not affect the report.</p>
            <div className="exportActions">
                <scale-button variant="secondary" onClick={async () => {
                    await exportPDF(diagnostics, selectedRules, manualRules, editorViewRef);
                    setShowExportModal(false);
                }}><scale-icon-user-file-pdf-file aria-hidden="true" />Export to PDF</scale-button>
                <scale-button variant="secondary" onClick={async () => {
                    await exportJUnit(diagnostics, selectedRules, manualRules, editorViewRef);
                    setShowExportModal(false);
                }}><scale-icon-action-download aria-hidden="true" />Export to jUnit</scale-button>
                <scale-button variant="secondary" onClick={handleExportReportPortal} disabled={isExporting}>
                    <scale-icon-action-export aria-hidden="true" />{isExporting ? "Exporting…" : "Export to ReportPortal"}
                </scale-button>
            </div>
        </ScaleDialog>}
    </div>;
};

export default HomePage;
