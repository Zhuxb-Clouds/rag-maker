import ts from "typescript";
import type { TextChunk } from "./semantic-chunker.js";
import { fallbackChunk } from "./fallback-chunker.js";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("chunker:ast");

// ─── Types ───

/** Structural info extracted from a single AST declaration. */
interface AstSymbol {
    /** Symbol name (e.g. "MyClass", "handleClick") */
    name: string;
    /** Kind label for the metadata header */
    kind: string;
    /** Whether the symbol is exported */
    exported: boolean;
    /** Full source text of the declaration (including leading comments) */
    text: string;
    /** 0-based start position in the original source */
    pos: number;
}

/** Import dependency extracted from an ImportDeclaration. */
interface ImportInfo {
    /** Module specifier (e.g. "node:crypto", "./types.js") */
    module: string;
    /** Named imports (e.g. ["readFile", "writeFile"]) — empty for namespace/default imports */
    names: string[];
}

// ─── Helpers ───

/** Build the metadata header prepended to each chunk. */
function buildHeader(
    filePath: string,
    symbol: { name: string; kind: string; exported: boolean },
    imports: ImportInfo[],
): string {
    const lines: string[] = [];
    lines.push(`// File: ${filePath}`);

    const exportTag = symbol.exported ? "exported " : "";
    lines.push(`// Symbol: ${symbol.name} (${exportTag}${symbol.kind})`);

    if (imports.length > 0) {
        const modules = imports.map((i) => i.module).join(", ");
        lines.push(`// Imports: ${modules}`);
    }

    return lines.join("\n") + "\n\n";
}

/** Check whether a node has an `export` modifier or is a default export. */
function isExported(node: ts.Node): boolean {
    // Check for `export` / `export default` modifiers
    if (ts.canHaveModifiers(node)) {
        const mods = ts.getModifiers(node);
        if (mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return true;
    }
    return false;
}

/** Get the declared name of a node, if any. */
function getNodeName(node: ts.Node): string | undefined {
    if (
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node)
    ) {
        return node.name?.getText();
    }
    return undefined;
}

/** Extract the source text with any leading JSDoc / comment block. */
function getFullText(node: ts.Node, sourceFile: ts.SourceFile): string {
    const fullStart = node.getFullStart();
    const end = node.getEnd();
    const textWithTrivia = sourceFile.text.slice(fullStart, end);

    // Trim only leading blank lines (preserve comment blocks)
    return textWithTrivia.replace(/^\s*\n/, "");
}

/** Map a TS SyntaxKind to a human-readable kind label. */
function kindLabel(node: ts.Node): string {
    if (ts.isFunctionDeclaration(node)) return "function";
    if (ts.isClassDeclaration(node)) return "class";
    if (ts.isInterfaceDeclaration(node)) return "interface";
    if (ts.isTypeAliasDeclaration(node)) return "type";
    if (ts.isEnumDeclaration(node)) return "enum";
    if (ts.isVariableStatement(node)) return "variable";
    return "declaration";
}

/** Extract all import declarations from the source file. */
function extractImports(sourceFile: ts.SourceFile): ImportInfo[] {
    const imports: ImportInfo[] = [];

    for (const stmt of sourceFile.statements) {
        if (!ts.isImportDeclaration(stmt)) continue;

        const moduleSpec = stmt.moduleSpecifier;
        if (!ts.isStringLiteral(moduleSpec)) continue;

        const moduleName = moduleSpec.text;
        const names: string[] = [];

        const clause = stmt.importClause;
        if (clause) {
            // Default import
            if (clause.name) {
                names.push(clause.name.text);
            }
            // Named / namespace imports
            if (clause.namedBindings) {
                if (ts.isNamedImports(clause.namedBindings)) {
                    for (const el of clause.namedBindings.elements) {
                        names.push(el.name.text);
                    }
                } else if (ts.isNamespaceImport(clause.namedBindings)) {
                    names.push(`* as ${clause.namedBindings.name.text}`);
                }
            }
        }

        imports.push({ module: moduleName, names });
    }

    return imports;
}

/** Collect names from an `export { A, B } from "./mod"` or `export { A, B }`. */
function extractReExportNames(node: ts.ExportDeclaration): string[] {
    const names: string[] = [];
    if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) {
            names.push((el.propertyName ?? el.name).getText());
        }
    }
    return names;
}

/**
 * Check if a VariableStatement contains "interesting" declarations worth
 * extracting as individual chunks (arrow functions, object literals, etc.)
 * rather than grouping them into the preamble.
 */
function isSignificantVariable(node: ts.VariableStatement): boolean {
    for (const decl of node.declarationList.declarations) {
        if (!decl.initializer) continue;
        const init = decl.initializer;
        if (
            ts.isArrowFunction(init) ||
            ts.isFunctionExpression(init) ||
            ts.isClassExpression(init) ||
            ts.isObjectLiteralExpression(init) ||
            ts.isCallExpression(init)
        ) {
            return true;
        }
    }
    return false;
}

/** Get declared variable names from a VariableStatement. */
function getVariableNames(node: ts.VariableStatement): string[] {
    const names: string[] = [];
    for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
            names.push(decl.name.text);
        }
    }
    return names;
}

// ─── Main entry ───

/**
 * Parse TypeScript / JavaScript source code using the TS compiler API
 * and split it into structural chunks (one per function / class / interface / etc.).
 *
 * Each chunk is prepended with a metadata header:
 * ```
 * // File: src/utils/hash.ts
 * // Symbol: contentHash (exported function)
 * // Imports: node:crypto
 * ```
 *
 * Falls back to text-based splitting if AST parsing fails.
 *
 * @param content     Raw file content
 * @param filePath    Relative file path (for metadata header)
 * @param maxChunkSize  Maximum chunk size in characters
 * @returns TextChunk[] compatible with the existing chunker contract
 */
export async function astChunkTypeScript(
    content: string,
    filePath: string,
    maxChunkSize: number = 1000,
): Promise<TextChunk[]> {
    // Determine script kind from extension
    let scriptKind = ts.ScriptKind.TS;
    if (filePath.endsWith(".tsx")) scriptKind = ts.ScriptKind.TSX;
    else if (filePath.endsWith(".jsx")) scriptKind = ts.ScriptKind.JSX;
    else if (filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs"))
        scriptKind = ts.ScriptKind.JS;

    let sourceFile: ts.SourceFile;
    try {
        sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, scriptKind);
    } catch (err) {
        log.warn({ err, filePath }, "AST parse failed, falling back to text chunking");
        return fallbackChunk(content, { maxChunkSize });
    }

    const imports = extractImports(sourceFile);
    const symbols: AstSymbol[] = [];
    const preambleSegments: string[] = [];

    // Track which ranges we've claimed so we can collect orphan code
    const claimedRanges: Array<{ start: number; end: number }> = [];

    for (const stmt of sourceFile.statements) {
        // Skip import declarations — they go into every header
        if (ts.isImportDeclaration(stmt)) {
            claimedRanges.push({ start: stmt.getFullStart(), end: stmt.getEnd() });
            continue;
        }

        // Re-exports: `export { A, B } from "./mod"`
        if (ts.isExportDeclaration(stmt)) {
            const names = extractReExportNames(stmt);
            const text = getFullText(stmt, sourceFile);
            if (names.length > 0) {
                symbols.push({
                    name: names.join(", "),
                    kind: "re-export",
                    exported: true,
                    text,
                    pos: stmt.getFullStart(),
                });
            } else {
                preambleSegments.push(text);
            }
            claimedRanges.push({ start: stmt.getFullStart(), end: stmt.getEnd() });
            continue;
        }

        // Export assignment: `export default ...` or `export = ...`
        if (ts.isExportAssignment(stmt)) {
            const text = getFullText(stmt, sourceFile);
            symbols.push({
                name: "default",
                kind: "export-default",
                exported: true,
                text,
                pos: stmt.getFullStart(),
            });
            claimedRanges.push({ start: stmt.getFullStart(), end: stmt.getEnd() });
            continue;
        }

        // Named declarations: function, class, interface, type, enum
        if (
            ts.isFunctionDeclaration(stmt) ||
            ts.isClassDeclaration(stmt) ||
            ts.isInterfaceDeclaration(stmt) ||
            ts.isTypeAliasDeclaration(stmt) ||
            ts.isEnumDeclaration(stmt)
        ) {
            const name = getNodeName(stmt) ?? "<anonymous>";
            symbols.push({
                name,
                kind: kindLabel(stmt),
                exported: isExported(stmt),
                text: getFullText(stmt, sourceFile),
                pos: stmt.getFullStart(),
            });
            claimedRanges.push({ start: stmt.getFullStart(), end: stmt.getEnd() });
            continue;
        }

        // Variable statements — only extract significant ones (arrow fns, etc.)
        if (ts.isVariableStatement(stmt)) {
            if (isSignificantVariable(stmt)) {
                const varNames = getVariableNames(stmt);
                symbols.push({
                    name: varNames.join(", ") || "<variable>",
                    kind: "variable",
                    exported: isExported(stmt),
                    text: getFullText(stmt, sourceFile),
                    pos: stmt.getFullStart(),
                });
            } else {
                preambleSegments.push(getFullText(stmt, sourceFile));
            }
            claimedRanges.push({ start: stmt.getFullStart(), end: stmt.getEnd() });
            continue;
        }

        // Everything else → preamble
        preambleSegments.push(getFullText(stmt, sourceFile));
        claimedRanges.push({ start: stmt.getFullStart(), end: stmt.getEnd() });
    }

    // Sort symbols by position so chunk order matches source order
    symbols.sort((a, b) => a.pos - b.pos);

    // ─── Build chunks ───

    const chunks: TextChunk[] = [];
    let chunkIndex = 0;

    // Preamble chunk: imports block + unclaimed top-level statements
    if (preambleSegments.length > 0) {
        const preambleBody = preambleSegments.join("\n\n");
        const header = buildHeader(filePath, { name: "<module>", kind: "preamble", exported: false }, imports);
        const fullText = header + preambleBody;

        if (fullText.length <= maxChunkSize) {
            chunks.push({ text: fullText, index: chunkIndex++ });
        } else {
            // Split oversized preamble
            const subChunks = await fallbackChunk(preambleBody, { maxChunkSize: maxChunkSize - header.length });
            for (const sub of subChunks) {
                chunks.push({ text: header + sub.text, index: chunkIndex++ });
            }
        }
    }

    // One chunk per symbol
    for (const sym of symbols) {
        const header = buildHeader(filePath, sym, imports);
        const fullText = header + sym.text;

        if (fullText.length <= maxChunkSize) {
            chunks.push({ text: fullText, index: chunkIndex++ });
        } else {
            // Oversized declaration → sub-split with header on each sub-chunk
            const subChunks = await fallbackChunk(sym.text, {
                maxChunkSize: maxChunkSize - header.length,
            });
            for (const sub of subChunks) {
                chunks.push({ text: header + sub.text, index: chunkIndex++ });
            }
        }
    }

    // Edge case: file has only imports and nothing else
    if (chunks.length === 0) {
        const header = buildHeader(filePath, { name: "<module>", kind: "preamble", exported: false }, imports);
        const importBlock = imports.length > 0
            ? sourceFile.statements
                .filter(ts.isImportDeclaration)
                .map((s) => s.getText(sourceFile))
                .join("\n")
            : content.trim();
        chunks.push({ text: header + importBlock, index: 0 });
    }

    log.debug(
        { filePath, symbols: symbols.length, preambleSegments: preambleSegments.length, chunks: chunks.length },
        "AST chunking complete",
    );

    return chunks;
}
