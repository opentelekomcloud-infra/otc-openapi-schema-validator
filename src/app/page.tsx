'use client';

import React, { useState, useRef, useEffect, SyntheticEvent, useMemo } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { yaml } from "@codemirror/lang-yaml";
import { EditorView } from "@codemirror/view";
import { linter, lintGutter } from "@codemirror/lint";
import { openApiLinter } from "@/components/Linter";
import RulesetsSelector from "@/components/RulesetsSelector";

interface Diagnostic {
    from: number;
    to: number;
    severity: string;
    message: string;
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

    const handleSelectionChange = (newSelection: Record<string, any>) => {
        setSelectedRules(newSelection);
        console.log("Selected file rules updated:", newSelection);
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
            {/* Upload Button */}
            <div className="p-4 bg-gray-200 flex justify-between">
                <label className="bg-blue-500 text-white px-4 py-2 rounded cursor-pointer">
                    Load YAML File
                    <input
                        type="file"
                        accept=".yaml,.yml"
                        className="hidden"
                        onChange={handleFileUpload}
                    />
                </label>
                <div className="flex space-x-4">
                    <div className="flex items-center">
            <span
                className="rounded-full mr-1"
                style={{
                    width: "10px",
                    height: "10px",
                    backgroundColor: "white",
                    border: "1px solid black",
                }}
            ></span>
                        <span>Hint</span>
                    </div>
                    <div className="flex items-center">
            <span
                className="rounded-full mr-1 border border-black"
                style={{width: "10px", height: "10px", backgroundColor: "oklch(.546 .245 262.881)"}}
            ></span>
                        <span>Info</span>
                    </div>
                    <div className="flex items-center">
            <span
                className="rounded-full mr-1 border border-black"
                style={{width: "10px", height: "10px", backgroundColor: "oklch(.681 .162 75.834)"}}
            ></span>
                        <span>Warning</span>
                    </div>
                    <div className="flex items-center">
            <span
                className="rounded-full mr-1 border border-black"
                style={{width: "10px", height: "10px", backgroundColor: "oklch(.577 .245 27.325)"}}
            ></span>
                        <span>Error</span>
                    </div>
                </div>
            </div>

            <div className="flex flex-1">
                {/* Left Panel - Code Editor */}
                <div className="relative w-1/2 border-r border-gray-300 p-4 bg-gray-100">
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
                <div className="w-1/2 p-4 bg-white overflow-auto">
                    <RulesetsSelector onSelectionChange={handleSelectionChange} />
                    <div className="mt-4 p-4 border">
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
                                    <th className="border px-2 py-1">Line #</th>
                                    <th className="border px-2 py-1">Summary</th>
                                    <th className="border px-2 py-1">Severity</th>
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
        </div>
    );
};

export default HomePage;