'use client';

import React, { useState, useRef, useEffect, SyntheticEvent, useMemo } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { yaml } from "@codemirror/lang-yaml";
import { EditorView } from "@codemirror/view";
import { linter, lintGutter } from "@codemirror/lint";
import { openApiLinter } from "@/components/Linter";
import RulesetsSelector from "@/components/RulesetsSelector";

// Define a type for CodeMirror diagnostics (you can adjust as needed)
interface Diagnostic {
    from: number;
    to: number;
    severity: string;
    message: string;
}

const HomePage = () => {
    const [code, setCode] = useState("// Start coding...");
    const [showScrollButton, setShowScrollButton] = useState(false);
    const scrollRef = useRef<HTMLElement | null>(null);
    const editorViewRef = useRef<EditorView | null>(null);
    const [selectedRules, setSelectedRules] = useState<Record<string, any>>({});
    const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
    // Use a ref to keep track of the last diagnostics so we don't update unnecessarily.
    const prevDiagsRef = useRef<Diagnostic[]>([]);

    // Memoize the update listener extension so it only changes when selectedRules changes.
    const diagnosticsListenerExtension = useMemo(
        () =>
            EditorView.updateListener.of((update) => {
                // Call our linter function with the current view and selected rules.
                const newDiags = openApiLinter(selectedRules)(update.view);
                // Only update state if diagnostics have changed.
                if (JSON.stringify(newDiags) !== JSON.stringify(prevDiagsRef.current)) {
                    prevDiagsRef.current = newDiags;
                    setDiagnostics(newDiags);
                }
            }),
        [selectedRules]
    );

    // Callback to capture the CodeMirror editor instance.
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

    // A helper function to sort diagnostics by severity.
    // (Assuming "error" is more severe than "warning".)
    const sortDiagnostics = (diags: Diagnostic[]) => {
        return diags.slice().sort((a, b) => {
            if (a.severity === b.severity) return 0;
            return a.severity === "error" ? -1 : 1;
        });
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
                // @ts-ignore
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
                        <h3 className="font-bold">Main Page - Selected File Rules</h3>
                        <pre>{JSON.stringify(selectedRules, null, 2)}</pre>
                    </div>
                    <div className="mt-4 p-4 border">
                        <h3 className="font-bold mb-2">Lint Issues (Sorted by Severity)</h3>
                        {diagnostics.length === 0 ? (
                            <p className="text-gray-500">No lint issues.</p>
                        ) : (
                            <ul className="list-disc pl-4">
                                {sortDiagnostics(diagnostics).map((diag, index) => {
                                    const lineNumber = editorViewRef.current
                                        ? editorViewRef.current.state.doc.lineAt(diag.from).number
                                        : "N/A";
                                    return (
                                        <li
                                            key={index}
                                            onClick={() => handleDiagnosticClick(diag.from)}
                                            className="cursor-pointer hover:underline mb-1"
                                        >
                                            [Line {lineNumber}] {diag.message} ({diag.severity})
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default HomePage;