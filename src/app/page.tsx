'use client';

import React, { useState, useRef, useEffect, SyntheticEvent, useMemo } from "react";
import Image from "next/image";
import CodeMirror from "@uiw/react-codemirror";
import { yaml } from "@codemirror/lang-yaml";
import { EditorView } from "@codemirror/view";
import { linter, lintGutter } from "@codemirror/lint";
import { openApiLinter } from "@/components/Linter";
import RulesetsSelector from "@/components/RulesetsSelector";
import ManualChecksSelector, { ManualRule } from "@/components/ManualChecksSelector";
import {exportJUnit, exportPDF, exportReportPortal} from "@/utils/export";
import { getSeverityLabel, severityToDiagnosticMap } from "@/utils/mapSeverity";
import "@telekom/scale-components/dist/scale-components/scale-components.css";
import { applyPolyfills, defineCustomElements } from "@telekom/scale-components/loader";
import { loadAllowedAbbreviationsFromApi } from "@/utils/englishWords";
import AuthButtons from "@/components/AuthButtons";

declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'scale-button': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        variant?: string;
        size?: string;
        disabled?: boolean;
      };
      'scale-card': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      'scale-tag': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      'scale-logo': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        variant?: string;
      };
    }
  }
}

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
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const [selectedRules, setSelectedRules] = useState<Record<string, any>>({});
    const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
    const prevDiagsRef = useRef<Diagnostic[]>([]);
    const [severityFilter, setSeverityFilter] = useState<string>("all");
    const [manualsIsOpen, setManualsIsOpen] = useState(true);
    const [manualRules, setManualRules] = useState<ManualRule[]>([]);
    const [showExportModal, setShowExportModal] = useState(false);
    const [sort, setSort] = useState<{ key: 'line' | 'id' | 'summary' | 'severity'; dir: 'asc' | 'desc' }>({ key: 'severity', dir: 'desc' });

    const [editorHeight, setEditorHeight] = useState<number>(0);
    const [specTitle, setSpecTitle] = useState<string | null>(null);
    const headerRef = useRef<HTMLDivElement>(null);
    const footerRef = useRef<HTMLDivElement>(null);
    const [isExporting, setIsExporting] = useState(false);

    const [totalAvailableRules, setTotalAvailableRules] = useState<number>(0);

    const selectedRulesCount = useMemo(() => {
      const entries = Object.entries(selectedRules ?? {});
      return entries.reduce((acc, [, v]) => (v ? acc + 1 : acc), 0);
    }, [selectedRules]);

    const totalRulesCount = totalAvailableRules;

    const { selectedManualRulesCount, totalManualRulesCount } = useMemo(() => {
      const total = manualRules?.length ?? 0;
      const selected = (manualRules ?? []).reduce((acc, r) => {
        const anyR = r as any;
        const isSelected =
          anyR?.verified ??
          false;
        return isSelected ? acc + 1 : acc;
      }, 0);
      return { selectedManualRulesCount: selected, totalManualRulesCount: total };
    }, [manualRules]);

  useEffect(() => {
      loadAllowedAbbreviationsFromApi();
    }, []);

    useEffect(() => {
      const calc = () => {
        const headerH = headerRef.current?.offsetHeight ?? 0;
        const footerH = footerRef.current?.offsetHeight ?? 0;
        setEditorHeight(window.innerHeight - headerH - footerH);
      };
      calc();
      window.addEventListener('resize', calc);
      return () => window.removeEventListener('resize', calc);
    }, []);

    const filteredDiagnostics = diagnostics.filter((diag) =>
        severityFilter === "all" ? true : diag.severity === severityToDiagnosticMap[severityFilter]
    );

    const toggleSort = (key: 'line' | 'id' | 'summary' | 'severity') =>
      setSort((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }));

    const sortedDiagnostics = useMemo(() => {
      const arr = [...filteredDiagnostics];
      const order = sort.dir === 'asc' ? 1 : -1;
      const rank = (s: string) => ({ error: 3, warning: 2, info: 1, hint: 0 }[s] ?? -1);
      return arr.sort((a, b) => {
        if (sort.key === 'line') {
          const la = editorViewRef.current?.state.doc.lineAt(a.from).number ?? 0;
          const lb = editorViewRef.current?.state.doc.lineAt(b.from).number ?? 0;
          return la === lb ? 0 : la > lb ? order : -order;
        }
        if (sort.key === 'id') return ((a.source || '').localeCompare(b.source || '')) * order;
        if (sort.key === 'summary') return a.message.localeCompare(b.message) * order;
        // severity
        return (rank(a.severity) - rank(b.severity)) * order;
      });
    }, [filteredDiagnostics, sort]);

    const diagnosticsListenerExtension = useMemo(
        () =>
            EditorView.updateListener.of(async (update) => {
                const { diagnostics: newDiags, specTitle: newTitle } = await openApiLinter(selectedRules)(update.view);
                if (newTitle !== specTitle) {
                  setSpecTitle(newTitle ?? null);
                }
                if (JSON.stringify(newDiags) !== JSON.stringify(prevDiagsRef.current)) {
                    prevDiagsRef.current = newDiags;
                    setDiagnostics(newDiags);
                }
            }),
        [selectedRules, specTitle]
    );

    useEffect(() => {
      applyPolyfills().then(() => {
        defineCustomElements(window);
      });
    }, []);

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
                reader.onload = (e) => {
                  prevDiagsRef.current = [];
                  setDiagnostics([]);
                  setSpecTitle(null);
                  setCode(e.target?.result as string);
                };
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

    const handleExport = () => {
        setShowExportModal(true);
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

    const handleManualRulesChange = (rules: ManualRule[]) => {
        setManualRules(rules);
    };

    // Helper functions for Lint Issues table
    const ariaSortFor = (key: 'line'|'id'|'summary'|'severity') =>
      sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined;
    const handleHeaderKeyUp = (e: React.KeyboardEvent, key: 'line'|'id'|'summary'|'severity') => {
      if (e.key === 'Enter' || e.key === ' ') toggleSort(key);
    };

    const handleExportReportPortal = async () => {
      setIsExporting(true);
      try {
        await exportReportPortal(diagnostics, selectedRules, manualRules, editorViewRef, {
          project: "openapi",
          launch: `Service: ${specTitle ?? 'OpenAPI'}`,
          description: `Latest launch for ${specTitle ?? 'OpenAPI'} - ${new Date().toISOString()}`,
          mode: "DEFAULT",
        });
        setShowExportModal(false);
        alert("Exported to ReportPortal successfully.");
      } catch (err) {
        console.error(err);
        alert("Export failed: " + (err as Error).message);
      } finally {
        setIsExporting(false);
      }
    };

    return (
      <div className="flex h-screen flex-col">
        {/* Header with Upload, Save Button and Severity Legend */}
        <header className="bg-white flex items-center shadow-md z-10" ref={headerRef}>
          <div
            className="flex items-center justify-center"
            style={{backgroundColor: "#e20074", width: "66px", height: "66px"}}
          >
            <scale-logo variant="white"></scale-logo>
          </div>
          <h1 className="ml-3 font-bold">OpenAPI Specification Validation</h1>
          <div className="flex gap-3 ml-auto mr-4">
            {/* Load YAML */}
            <scale-button
              onClick={() => fileInputRef.current?.click()}
              variant="primary"
              size="m"
            >
              <Image
                src="/images/open-folder.png"
                width={32}
                height={32}
                alt="Load YAML File"
                className="w-8 h-8 mr-2"
              />
              Load
            </scale-button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".yaml,.yml"
              className="hidden"
              onChange={handleFileUpload}
            />

            {/* Save */}
            <scale-button onClick={handleSave} size="m" variant="secondary">
              <Image
                src="/images/save.png"
                width={32}
                height={32}
                alt="Save YAML File"
                className="w-8 h-8 mr-2"
              />
              Save
            </scale-button>

            {/* Export */}
            <scale-button onClick={handleExport} variant="secondary" size="m">
              <Image
                src="/images/export.png"
                width={32}
                height={32}
                alt="Export Issues"
                className="w-8 h-8 mr-2"
              />
              Export
            </scale-button>

            <div className="flex gap-3 ml-auto mr-4 items-center">
              <AuthButtons/>
            </div>
          </div>
        </header>

        <div className="flex flex-1 overflow-hidden">
          {/* Left Panel - Code Editor */}
          <div className="relative w-1/2 border-r border-gray-300 bg-gray-100 h-full flex flex-col min-h-0">
            <CodeMirror
              value={code}
              height={`${editorHeight}px`}
              extensions={[
                yaml(),
                linter((v) => openApiLinter(selectedRules)(v).then(r => r.diagnostics)),
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
              <scale-button
                onClick={scrollToTop}
                className="absolute bottom-10 right-10 text-white p-2 rounded shadow-md transition"
              >
                ↑ Top
              </scale-button>
            )}
          </div>
          {/* Right Panel - Rules Selection and Lint Issues List */}
          <div className="w-1/2 p-4 bg-white overflow-auto h-full">
            <scale-card className="block p-4 mb-4">
                          <span className="mr-2 font-semibold inline-flex items-center gap-2">
              <span className="text-xs font-normal text-gray-600">
                    Rules selected: {selectedRulesCount}/{totalRulesCount}
              </span>
            </span>
              <RulesetsSelector
                onSelectionChange={handleSelectionChange}
                onTotalRulesChange={setTotalAvailableRules}
              />
            </scale-card>

            <scale-card className="block p-4 mb-4">
              <div className="mt-1 hover:shadow-lg transition duration-200">
                <span className="text-xs font-normal text-gray-600">
                  Rules verified: {selectedManualRulesCount}/{totalManualRulesCount}
                </span>
                <h3
                  className="font-bold mb-2 cursor-pointer"
                  onClick={() => setManualsIsOpen(!manualsIsOpen)}
                >
                  Manual Checklist {manualsIsOpen ? '▲' : '▼'}
                </h3>
                <div className={manualsIsOpen ? "" : "hidden"}>
                  <ManualChecksSelector onManualRulesChange={handleManualRulesChange}/>
                </div>
              </div>
            </scale-card>

            <scale-card className="block p-4">
              <h3 className="font-bold mb-2">Lint Issues</h3>
              <div className="mb-2">
                <label className="mr-2 font-semibold">Filter by Severity:</label>
                <select
                  className="border p-2 rounded-md"
                  value={severityFilter}
                  onChange={(e) => setSeverityFilter(e.target.value)}
                >
                  <option value="all">All</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="critical">Critical</option>
                </select>
              </div>
              {filteredDiagnostics.length === 0 ? (
                <p className="text-gray-500">No lint issues.</p>
              ) : (
                <table className="w-full border-collapse table-fixed rounded-t-lg rounded-b-lg overflow-hidden">
                  <thead>
                  <tr>
                    <th
                      scope="col"
                      className="px-2 py-1 w-1/8 bg-gray-200 cursor-pointer hover:bg-gray-300 w-[5%]"
                      aria-sort={ariaSortFor("line")}
                      onKeyUp={(e) => handleHeaderKeyUp(e, "line")}
                    >
                      <button onClick={() => toggleSort("line")} className="w-full text-left flex items-center group">
                        #
                        <span
                          className={`ml-1 text-xs ${sort.key === "line" ? "inline" : "hidden group-hover:inline"} ${sort.dir === "asc" ? "text-gray-500" : "text-gray-500 rotate-180"} group-hover:text-pink-500`}>
                                ▲
                              </span>
                      </button>
                    </th>
                    <th
                      scope="col"
                      className="px-2 py-1 w-1/8 bg-gray-200 cursor-pointer hover:bg-gray-300 w-[20%]"
                      aria-sort={ariaSortFor("id")}
                      onKeyUp={(e) => handleHeaderKeyUp(e, "id")}
                    >
                      <button onClick={() => toggleSort("id")} className="w-full text-left flex items-center group">
                        ID
                        <span
                          className={`ml-1 text-xs ${sort.key === "id" ? "inline" : "hidden group-hover:inline"} ${sort.dir === "asc" ? "text-gray-500" : "text-gray-500 rotate-180"} group-hover:text-pink-500`}>
                                ▲
                              </span>
                      </button>
                    </th>
                    <th
                      scope="col"
                      className="px-2 py-1 w-5/8 bg-gray-200 cursor-pointer hover:bg-gray-300 w-[40%]"
                      aria-sort={ariaSortFor("summary")}
                      onKeyUp={(e) => handleHeaderKeyUp(e, "summary")}
                    >
                      <button onClick={() => toggleSort("summary")}
                              className="w-full text-left flex items-center group">
                        Summary
                        <span
                          className={`ml-1 text-xs ${sort.key === "summary" ? "inline" : "hidden group-hover:inline"} ${sort.dir === "asc" ? "text-gray-500" : "text-gray-500 rotate-180"} group-hover:text-pink-500`}>
                                ▲
                              </span>
                      </button>
                    </th>
                    <th
                      scope="col"
                      className="px-2 py-1 w-1/8 bg-gray-200 cursor-pointer hover:bg-gray-300"
                      style={{wordBreak: "normal", overflowWrap: "normal"}}
                      aria-sort={ariaSortFor("severity")}
                      onKeyUp={(e) => handleHeaderKeyUp(e, "severity")}
                    >
                      <button onClick={() => toggleSort("severity")}
                              className="w-full text-left flex items-center group">
                        Severity
                        <span
                          className={`ml-1 text-xs ${sort.key === "severity" ? "inline" : "hidden group-hover:inline"} ${sort.dir === "asc" ? "text-gray-500" : "text-gray-500 rotate-180"} group-hover:text-pink-500`}>
                                ▲
                              </span>
                      </button>
                    </th>
                  </tr>
                  </thead>
                  <tbody>
                  {sortedDiagnostics.map((diag, index) => {
                    const lineNumber = editorViewRef.current
                      ? editorViewRef.current.state.doc.lineAt(diag.from).number
                      : 'N/A';
                    let severityBg = '';
                    switch (diag.severity) {
                      case 'hint':
                        severityBg = 'bg-white';
                        break;
                      case 'info':
                        severityBg = 'bg-blue-200';
                        break;
                      case 'warning':
                        severityBg = 'bg-yellow-200';
                        break;
                      case 'error':
                        severityBg = 'bg-red-200';
                        break;
                      default:
                        severityBg = 'bg-gray-200';
                    }
                    return (
                      <tr
                        key={index}
                        onClick={() => handleDiagnosticClick(diag.from)}
                        className={`cursor-pointer hover:underline ${severityBg}`}
                      >
                        <td className="px-2 py-1 text-center"
                            style={{wordBreak: "normal", overflowWrap: "normal"}}>{lineNumber}</td>
                        <td className="px-2 py-1"
                            style={{wordBreak: "normal", overflowWrap: "normal"}}>{diag.source}</td>
                        <td className="px-2 py-1"
                            style={{wordBreak: "normal", overflowWrap: "normal"}}>{diag.message}</td>
                        <td className="text-center break-words whitespace-normal"
                        >
                          <scale-tag>{getSeverityLabel(diag.severity)}</scale-tag>
                        </td>
                      </tr>
                    );
                  })}
                  </tbody>
                </table>
              )}
            </scale-card>
          </div>
        </div>
        {/* Footer */}

        <footer className="bg-white-200 p-4 text-left text-sm indent-4" ref={footerRef}>
          © T-Systems International GmbH | 2026 EcoSystems | All rights reserved. |
          v{process.env.NEXT_PUBLIC_APP_VERSION ?? 'dev'}
        </footer>

        {/*Modal for Export Options*/}
        {showExportModal && (
          <div className="fixed inset-0 flex items-center justify-center bg-opacity-50 z-50"
               onClick={() => setShowExportModal(false)}
          >
            <div className="bg-white rounded-lg shadow-lg p-6 w-80"
                 onClick={(e) => e.stopPropagation()}
            >
              {/* X button inside modal */}
              <div className="inset-x-0 top-0 flex justify-end">
                <button
                  className="text-black-500 hover:text-black-700 hover:scale-115"
                  onClick={() => setShowExportModal(false)}
                >
                  X
                </button>
              </div>
              <h2 className="text-xl font-bold mb-4">Export</h2>
              {/* X button on the top right */}
              <div className="flex flex-col space-y-2">
                <scale-button
                  onClick={async () => {
                    await exportPDF(diagnostics, selectedRules, manualRules, editorViewRef);
                    setShowExportModal(false);
                  }}
                  size="m"
                >
                  <Image
                    src="/images/pdf.png"
                    width={32}
                    height={32}
                    alt="Export Issues"
                    className="w-8 h-8 mr-2"
                  />
                  Export to PDF
                </scale-button>
                <scale-button
                  onClick={async () => {
                    await exportJUnit(diagnostics, selectedRules, manualRules, editorViewRef);
                    setShowExportModal(false);
                  }}
                  size="m"
                >
                  <Image
                    src="/images/junit5.png"
                    width={32}
                    height={32}
                    alt="Export Issues"
                    className="w-8 h-8 mr-2"
                  />
                  Export to jUnit
                </scale-button>
                <scale-button
                  onClick={handleExportReportPortal}
                  disabled={isExporting}
                  variant="secondary"
                  size="m"
                  style={{
                    ['--background-secondary' as any]: '#ffffff',
                    ['--background-secondary-hover' as any]: 'hsla(0, 0%, 0%, 0.07)',
                    ['--background-secondary-active' as any]: 'hsla(0, 0%, 0%, 0.21)',
                    ['--border-secondary' as any]: '#000000',
                    ['--border-secondary-hover' as any]: '#000000',
                    ['--border-secondary-active' as any]: 'hsla(0, 0%, 0%, 0.21)',
                    ['--color-secondary' as any]: '#111111',
                    ['--color-secondary-hover' as any]: '#111111',
                    ['--color-secondary-active' as any]: '#111111',
                  }}
                >
                  {isExporting ? (
                    <>
                      <span className="inline-block mr-2 align-middle">
                        <span
                          className="animate-spin inline-block h-5 w-5 border-2 border-gray-300 border-t-pink-600 rounded-full"/>
                      </span>
                      Exporting…
                    </>
                  ) : (
                    <>
                      <Image
                        src="/images/rp.png"
                        width={32}
                        height={32}
                        alt="Export to ReportPortal"
                        className="w-8 h-8 mr-2"
                      />
                      Export to ReportPortal
                    </>
                  )}
                </scale-button>
              </div>
            </div>
          </div>
        )}

      </div>
    );
};

export default HomePage;
