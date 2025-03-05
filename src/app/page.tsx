'use client';

import React, {useState, useRef, useEffect, SyntheticEvent} from "react";
import CodeMirror from "@uiw/react-codemirror";
import { yaml } from "@codemirror/lang-yaml";
import type { EditorView } from "@codemirror/view";
// import jsyaml from "js-yaml";
import RulesetsSelector from "@/components/RulesetsSelector";

const HomePage = () => {
    const [code, setCode] = useState("// Start coding...");
    const [showScrollButton, setShowScrollButton] = useState(false);
    const scrollRef = useRef(null);

    // Scroll event handler for CodeMirror's scrollDOM
    const handleScroll = () => {
        if (scrollRef.current) {
            // @ts-expect-error arguing on possible null
            setShowScrollButton(scrollRef.current.scrollTop > 50);
        }
    };

    // Callback to capture the CodeMirror editor instance
    const handleEditorCreated = (editorView: EditorView) => {
        // @ts-expect-error arguing on possible null
        scrollRef.current = editorView.scrollDOM;
        // @ts-expect-error arguing on possible null
        scrollRef.current.addEventListener("scroll", handleScroll);
    };

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (scrollRef.current) {
                // @ts-expect-error arguing on possible null
                scrollRef.current.removeEventListener("scroll", handleScroll);
            }
        };
    }, []);

    const scrollToTop = () => {
        if (scrollRef.current) {
            // @ts-expect-error arguing on possible null
            scrollRef.current.scrollTo({ top: 0, behavior: "smooth" });
        }
    };

    const handleFileUpload = (event: SyntheticEvent) => {
        console.log(event)
        // @ts-expect-error arguing on files
        const file = event.target.files[0];
        if (file && (file.name.endsWith(".yaml") || file.name.endsWith(".yml"))) {
            const reader = new FileReader();
            // @ts-expect-error arguing on possible null
            reader.onload = (e) => setCode(e.target.result);
            reader.readAsText(file);
        } else {
            alert("Please upload a valid .yaml or .yml file.");
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
                        extensions={[yaml()]}
                        onChange={(value) => setCode(value)}
                        theme="dark"
                        basicSetup={{
                            lineNumbers: true,
                            foldGutter: true,
                        }}
                        // Use the callback to capture the editor instance
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
                {/* Right Panel - RulesetsFetcher and/or additional rules selection UI */}
                <div className="w-1/2 p-4 bg-white overflow-auto">
                    <RulesetsSelector />
                    {/* You can add your additional rules selection UI here,
              which could use the fetched structure from RulesetsFetcher */}
                </div>
            </div>
        </div>
    );
};

export default HomePage;