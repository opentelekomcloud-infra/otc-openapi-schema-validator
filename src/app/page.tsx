'use client';

import React, { useState, useRef, useEffect, SyntheticEvent, useMemo } from "react";
import Image from "next/image";
import CodeMirror from "@uiw/react-codemirror";
import { yaml } from "@codemirror/lang-yaml";
import { EditorView } from "@codemirror/view";
import { linter, lintGutter } from "@codemirror/lint";
import { jsPDF } from 'jspdf'
import { autoTable } from 'jspdf-autotable'
import { openApiLinter } from "@/components/Linter";
import RulesetsSelector from "@/components/RulesetsSelector";
import ManualChecksSelector, { fetchManualRulesFromAPI } from "@/components/ManualChecksSelector";
import {convertMarkdownToPlainText} from "@/utils/utils";

interface Diagnostic {
    from: number;
    to: number;
    severity: string;
    message: string;
    source?: string;
}

const HomePage = () => {
    const [code, setCode] = useState("// Start writing or load a file...");
    const [showScrollButton, setShowScrollButton] = useState(false);
    const scrollRef = useRef<HTMLElement | null>(null);
    const editorViewRef = useRef<EditorView | null>(null);
    const [selectedRules, setSelectedRules] = useState<Record<string, any>>({});
    const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
    const prevDiagsRef = useRef<Diagnostic[]>([]);
    const [severityFilter, setSeverityFilter] = useState<string>("all");

    const filteredDiagnostics = diagnostics.filter((diag) =>
        severityFilter === "all" ? true : diag.severity === severityFilter
    );

    const diagnosticsListenerExtension = useMemo(
        () =>
            EditorView.updateListener.of((update) => {
                const newDiags = openApiLinter(selectedRules)(update.view);
                if (JSON.stringify(newDiags) !== JSON.stringify(prevDiagsRef.current)) {
                    prevDiagsRef.current = newDiags;
                    setDiagnostics(newDiags);
                }
            }),
        [selectedRules]
    );

    const handleEditorCreated = (editorView: EditorView) => {
        editorViewRef.current = editorView;
        scrollRef.current = editorView.scrollDOM;
        scrollRef.current.addEventListener("scroll", handleScroll);
    };

    // Scroll event handler for CodeMirror's scrollDOM.
    const handleScroll = () => {
        if (scrollRef.current) {
            setShowScrollButton(scrollRef.current.scrollTop > 50);
        }
    };

    // Cleanup scroll listener on unmount.
    useEffect(() => {
        return () => {
            if (scrollRef.current) {
                scrollRef.current.removeEventListener("scroll", handleScroll);
            }
        };
    }, []);

    const scrollToTop = () => {
        if (scrollRef.current) {
            scrollRef.current.scrollTo({ top: 0, behavior: "smooth" });
        }
    };

    const handleFileUpload = (event: SyntheticEvent) => {
        const target = event.target as HTMLInputElement;
        if (target.files && target.files[0]) {
            const file = target.files[0];
            if (file.name.endsWith(".yaml") || file.name.endsWith(".yml")) {
                const reader = new FileReader();
                reader.onload = (e) => setCode(e.target?.result as string);
                reader.readAsText(file);
            } else {
                alert("Please upload a valid .yaml or .yml file.");
            }
        }
    };

    const handleSave = async () => {
        const blob = new Blob([code], { type: "text/yaml" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "modified.yaml";
        a.click();
        URL.revokeObjectURL(url);
    };

    const handleExport = async () => {
        const doc = new jsPDF() as jsPDF & { lastAutoTable: { finalY: number } };

        // --- Found Issues ---
        doc.setFontSize(16);
        doc.text("Automated Compliance Validation report", 14, 20);
        const tableColumn = ["Line #", "Summary", "Severity", "Rule ID"];
        const tableRows: (string | number)[][] = [];

        diagnostics.forEach((diag) => {
            const lineNumber = editorViewRef.current
                ? editorViewRef.current.state.doc.lineAt(diag.from).number
                : "N/A";
            tableRows.push([lineNumber, diag.message, diag.severity, diag.source || ""]);
        });

        autoTable(doc,{
            head: [tableColumn],
            body: tableRows,
            startY: 30,
            styles: { fontSize: 10, cellPadding: 3 },
            margin: { top: 37 },
            headStyles: {
                fillColor: [226, 0, 116],
                fontSize: 12,
            },
        });

        const afterLintY = doc.lastAutoTable?.finalY || 40;

        // --- Manual Rules ---
        const allManualRules = await fetchManualRulesFromAPI()
        doc.setFontSize(16);
        doc.text("Manual Checklist", 14, afterLintY + 15);

        const manualTableColumn = ["ID", "Title", "Summary", "Severity"];
        const manualTableRows: (string | number)[][] = allManualRules.map((rule) => [
            rule.id,
            rule.title,
            convertMarkdownToPlainText(rule.message),
            rule.option,
        ]);

        autoTable(doc, {
            head: [manualTableColumn],
            body: manualTableRows,
            startY: afterLintY + 20,
            styles: { fontSize: 10, cellPadding: 3 },
            headStyles: {
                fillColor: [226, 0, 116],
                fontSize: 12,
            },
        });

        doc.save("lint-report.pdf");
    };

    const handleSelectionChange = (newSelection: Record<string, any>) => {
        setSelectedRules(newSelection);
    };

    const handleDiagnosticClick = (from: number) => {
        if (editorViewRef.current && scrollRef.current) {
            editorViewRef.current.dispatch({
                selection: { anchor: from },
                scrollIntoView: false,
            });
            requestAnimationFrame(() => {
                const coords = editorViewRef.current!.coordsAtPos(from);
                const containerRect = scrollRef.current!.getBoundingClientRect();
                // @ts-expect-error coords possible null
                const offsetWithinContainer = coords.top - containerRect.top;
                const newScrollTop = scrollRef.current!.scrollTop + offsetWithinContainer - 20;
                scrollRef.current!.scrollTo({ top: newScrollTop, behavior: "smooth" });
            });
        }
    };

    return (
        <div className="flex h-screen flex-col">
            {/* Header with Upload, Save Button and Severity Legend */}
            <header className="p-2 bg-gray-200 flex justify-between items-center shadow-lg">
                <div className="flex space-x-2 items-center">
                    <label
                        title="Select a YAML file to load"
                        className="inline-flex items-center text-white px-0 py-2 rounded cursor-pointer"
                    >
                        <Image
                            src="/images/open-folder.png"
                            width={32}
                            height={32}
                            alt="Load YAML File"
                            className="w-8 h-8 mr-2 hover:shadow-lg hover:scale-105 transition duration-200"
                        />
                        <input
                            type="file"
                            accept=".yaml,.yml"
                            className="hidden"
                            onChange={handleFileUpload}
                        />
                    </label>
                    <label
                        title="Save modified"
                        className="inline-flex items-center text-white px-0 py-2 rounded cursor-pointer"
                    >
                        <Image
                            src="/images/save.png"
                            width={32}
                            height={32}
                            alt="Save YAML File"
                            className="w-8 h-8 mr-2 hover:shadow-lg hover:scale-105 transition duration-200"
                        />
                        <button onClick={handleSave} className="inline-flex"></button>
                    </label>
                    <div className="h-8 border-l border-gray mx-2"></div>
                    <label
                        title="Export lint issues"
                        className="inline-flex items-center text-white px-4 py-2 rounded cursor-pointer"
                    >
                        <Image
                            src="/images/export.png"
                            width={32}
                            height={32}
                            alt="Export Issues"
                            className="w-8 h-8 mr-2 hover:shadow-lg hover:scale-105 transition duration-200"
                        />
                        <button onClick={handleExport} className="inline-flex"></button>
                    </label>
                </div>
                <div className="flex space-x-4">
                    <div className="flex items-center">
            <span
                className="rounded-full mr-1"
                style={{width: "10px", height: "10px", backgroundColor: "white"}}
            ></span>
                        <span>Hint</span>
                    </div>
                    <div className="flex items-center">
            <span
                className="rounded-full mr-1"
                style={{width: "10px", height: "10px", backgroundColor: "oklch(.546 .245 262.881)"}}
            ></span>
                        <span>Info</span>
                    </div>
                    <div className="flex items-center">
            <span
                className="rounded-full mr-1"
                style={{width: "10px", height: "10px", backgroundColor: "oklch(.681 .162 75.834)"}}
            ></span>
                        <span>Warning</span>
                    </div>
                    <div className="flex items-center">
            <span
                className="rounded-full mr-1"
                style={{width: "10px", height: "10px", backgroundColor: "oklch(.577 .245 27.325)"}}
            ></span>
                        <span>Error</span>
                    </div>
                </div>
            </header>

            <div className="flex h-screen">
                {/* Left Panel - Code Editor */}
                <div className="relative w-1/2 border-r border-gray-300 bg-gray-100 h-full flex flex-col">
                    <CodeMirror
                        value={code}
                        height="100vh"
                        extensions={[
                            yaml(),
                            linter(openApiLinter(selectedRules)),
                            lintGutter(),
                            diagnosticsListenerExtension,
                        ]}
                        onChange={(value) => setCode(value)}
                        theme="dark"
                        basicSetup={{
                            lineNumbers: true,
                            foldGutter: true,
                        }}
                        onCreateEditor={handleEditorCreated}
                    />
                    {showScrollButton && (
                        <button
                            onClick={scrollToTop}
                            className="absolute bottom-10 right-10 bg-blue-500 text-white p-2 rounded shadow-md hover:bg-blue-600 transition"
                        >
                        ↑ Top
                        </button>
                    )}
                </div>
                {/* Right Panel - Rules Selection and Lint Issues List */}
                <div className="w-1/2 p-4 bg-white overflow-auto h-full">
                    <RulesetsSelector onSelectionChange={handleSelectionChange}/>
                    <div className="mt-4 p-4 border block whitespace-normal break-all">
                        <h3 className="font-bold mb-2">Manual Checklist</h3>
                        <ManualChecksSelector/>
                    </div>
                    <div className="mt-4 p-4 border block whitespace-normal break-all">
                        <h3 className="font-bold mb-2">Lint Issues</h3>
                        {/* Severity Filter Dropdown */}
                        <div className="mb-2">
                            <label className="mr-2 font-semibold">Filter by Severity:</label>
                            <select
                                className="border p-1"
                                value={severityFilter}
                                onChange={(e) => setSeverityFilter(e.target.value)}
                            >
                                <option value="all">All</option>
                                <option value="hint">Hint</option>
                                <option value="info">Info</option>
                                <option value="warning">Warning</option>
                                <option value="error">Error</option>
                            </select>
                        </div>
                        {filteredDiagnostics.length === 0 ? (
                            <p className="text-gray-500">No lint issues.</p>
                        ) : (
                            <table className="w-full border-collapse">
                                <thead>
                                <tr>
                                    <th className="border px-2 py-1 w-1/6">#</th>
                                    <th className="border px-2 py-1 w-4/6">Summary</th>
                                    <th className="border px-2 py-1 w-1/6">Severity</th>
                                </tr>
                                </thead>
                                <tbody>
                                {filteredDiagnostics.map((diag, index) => {
                                    const lineNumber = editorViewRef.current
                                        ? editorViewRef.current.state.doc.lineAt(diag.from).number
                                        : "N/A";
                                    let severityBg = "";
                                    switch (diag.severity) {
                                        case "hint":
                                            severityBg = "bg-white";
                                            break;
                                        case "info":
                                            severityBg = "bg-blue-200";
                                            break;
                                        case "warning":
                                            severityBg = "bg-yellow-200";
                                            break;
                                        case "error":
                                            severityBg = "bg-red-200";
                                            break;
                                        default:
                                            severityBg = "bg-gray-200";
                                    }
                                    return (
                                        <tr
                                            key={index}
                                            onClick={() => handleDiagnosticClick(diag.from)}
                                            className={`cursor-pointer hover:underline ${severityBg}`}
                                        >
                                            <td className="border px-2 py-1 text-center">{lineNumber}</td>
                                            <td className="border px-2 py-1">{diag.message}</td>
                                            <td className="border px-2 py-1 text-center">{diag.severity}</td>
                                        </tr>
                                    );
                                })}
                                </tbody>
                            </table>
                        )}
                    </div>
                </div>
            </div>
            {/* Footer */}
            <footer className="bg-gray-200 p-4 text-center">
                © 2025 EcoSystems. All rights reserved.
            </footer>
        </div>
    );
};

export default HomePage;