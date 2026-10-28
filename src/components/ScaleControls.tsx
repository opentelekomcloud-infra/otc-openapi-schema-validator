"use client";

import React, { useEffect, useId, useRef, useState } from "react";

export function ScaleSelect({ label, value, options, onChange, disabled = false }: {
    label: string;
    value: string;
    options: readonly { label: string; value: string }[];
    onChange: (value: string) => void;
    disabled?: boolean;
}) {
    const ref = useRef<HTMLScaleDropdownSelectElement>(null);
    const name = useId();
    useEffect(() => {
        const element = ref.current;
        if (!element) return;
        const change = () => {
            if (typeof element.value === "string") onChange(element.value);
        };
        element.addEventListener("scale-change", change);
        return () => element.removeEventListener("scale-change", change);
    }, [onChange]);
    return <scale-dropdown-select ref={ref} name={name} label={label} value={value} disabled={disabled}>
        {options.map((option) => <scale-dropdown-select-item key={option.value} value={option.value}>
            {option.label}
        </scale-dropdown-select-item>)}
    </scale-dropdown-select>;
}

export function ScaleSearch({ label, value, onChange }: {
    label: string; value: string; onChange: (value: string) => void;
}) {
    const ref = useRef<HTMLScaleTextFieldElement>(null);
    useEffect(() => {
        const element = ref.current;
        if (!element) return;
        const change = () => {
            if (typeof element.value === "string") onChange(element.value);
        };
        element.addEventListener("scale-input", change);
        element.addEventListener("scale-change", change);
        return () => {
            element.removeEventListener("scale-input", change);
            element.removeEventListener("scale-change", change);
        };
    }, [onChange]);
    return <scale-text-field ref={ref} label={label} value={value}
        inputModeType="search" experimentalControlled />;
}

export function ScaleCheckbox({ label, checked, onChange }: {
    label: string; checked: boolean; onChange: () => void;
}) {
    const ref = useRef<HTMLScaleCheckboxElement>(null);
    useEffect(() => {
        const element = ref.current;
        if (!element) return;
        element.addEventListener("scale-change", onChange);
        return () => element.removeEventListener("scale-change", onChange);
    }, [onChange]);
    return <scale-checkbox ref={ref} label={label} checked={checked} hideLabel />;
}

export function ScaleDialog({ heading, onClose, children }: {
    heading: string; onClose: () => void; children: React.ReactNode;
}) {
    const ref = useRef<HTMLScaleModalElement>(null);
    const closeRef = useRef(onClose);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => { closeRef.current = onClose; }, [onClose]);
    useEffect(() => {
        const element = ref.current;
        if (!element) return;
        let cancelled = false;
        let previousFocus = document.activeElement;
        while (previousFocus?.shadowRoot?.activeElement) previousFocus = previousFocus.shadowRoot.activeElement;
        const close = () => closeRef.current();
        element.addEventListener("scale-close", close);
        // Opening after hydration runs Scale's focus trap and Escape-key lifecycle.
        void customElements.whenDefined("scale-modal").then(() => element.componentOnReady()).then(() => {
            if (!cancelled) element.opened = true;
        }).catch((failure: unknown) => {
            console.error("Unable to initialize Scale dialog", failure);
            if (!cancelled) setError("Unable to open this dialog.");
        });
        return () => {
            cancelled = true;
            element.removeEventListener("scale-close", close);
            const active = document.activeElement;
            if ((active === document.body || active === element || element.contains(active)) &&
                previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
        };
    }, []);
    if (error) return <div role="alert">{error}<button onClick={onClose}>Close</button></div>;
    return <scale-modal ref={ref} heading={heading} closeButtonLabel="Close">
        {children}
    </scale-modal>;
}
