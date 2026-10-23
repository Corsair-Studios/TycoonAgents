#!/usr/bin/env node
/**
 * design-doc-cli.ts
 * Subcommands:
 *   md2docx <input.md> <output.docx>  — convert Markdown to .docx (uses `docx` library)
 *   docx2md <input.docx>              — extract text from .docx (uses fflate to unzip,
 *                                       parses <w:t> nodes from word/document.xml)
 *
 * NOTE on mammoth: mammoth uses dynamic require("fs") at module load time, which is
 * incompatible with esbuild's ESM bundle output (throws "Dynamic require of 'fs' is
 * not supported"). fflate is a pure-JS zip library that bundles cleanly with ESM.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
} from "docx";
import { unzipSync } from "fflate";

// ---------------------------------------------------------------------------
// md2docx
// ---------------------------------------------------------------------------
interface MdBlock {
  type: "heading1" | "heading2" | "heading3" | "bullet" | "paragraph";
  text: string;
}

function parseMd(src: string): MdBlock[] {
  const lines = src.split(/\r?\n/);
  const blocks: MdBlock[] = [];
  let paraLines: string[] = [];

  const flushPara = () => {
    const text = paraLines.join(" ").trim();
    if (text) blocks.push({ type: "paragraph", text });
    paraLines = [];
  };

  for (const line of lines) {
    if (/^### /.test(line)) {
      flushPara();
      blocks.push({ type: "heading3", text: line.slice(4).trim() });
    } else if (/^## /.test(line)) {
      flushPara();
      blocks.push({ type: "heading2", text: line.slice(3).trim() });
    } else if (/^# /.test(line)) {
      flushPara();
      blocks.push({ type: "heading1", text: line.slice(2).trim() });
    } else if (/^[-*] /.test(line)) {
      flushPara();
      blocks.push({ type: "bullet", text: line.slice(2).trim() });
    } else if (line.trim() === "") {
      flushPara();
    } else {
      paraLines.push(line);
    }
  }
  flushPara();
  return blocks;
}

/** Parse inline **bold** spans into TextRun[] */
function inlineRuns(text: string): TextRun[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/);
  return parts.map((part) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return new TextRun({ text: part.slice(2, -2), bold: true });
    }
    return new TextRun({ text: part });
  });
}

function blockToParagraph(block: MdBlock): Paragraph {
  switch (block.type) {
    case "heading1":
      return new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: block.text, bold: true })],
      });
    case "heading2":
      return new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: block.text, bold: true })],
      });
    case "heading3":
      return new Paragraph({
        heading: HeadingLevel.HEADING_3,
        children: [new TextRun({ text: block.text, bold: true })],
      });
    case "bullet":
      return new Paragraph({
        bullet: { level: 0 },
        children: inlineRuns(block.text),
      });
    default:
      return new Paragraph({
        children: inlineRuns(block.text),
      });
  }
}

async function md2docx(inputPath: string, outputPath: string): Promise<void> {
  if (!existsSync(inputPath)) {
    process.stderr.write(`Error: input file not found: ${inputPath}\n`);
    process.exit(1);
  }

  let src: string;
  try {
    src = readFileSync(inputPath, "utf8");
  } catch (e) {
    process.stderr.write(`Error reading ${inputPath}: ${(e as Error).message}\n`);
    process.exit(1);
  }

  const blocks = parseMd(src);
  const paragraphs = blocks.map(blockToParagraph);

  const doc = new Document({
    sections: [{ properties: {}, children: paragraphs }],
  });

  let buffer: Buffer;
  try {
    buffer = await Packer.toBuffer(doc);
  } catch (e) {
    process.stderr.write(`Error packing docx: ${(e as Error).message}\n`);
    process.exit(1);
  }

  try {
    writeFileSync(outputPath, buffer);
  } catch (e) {
    process.stderr.write(`Error writing ${outputPath}: ${(e as Error).message}\n`);
    process.exit(1);
  }

  process.stdout.write(`Wrote ${outputPath}\n`);
}

// ---------------------------------------------------------------------------
// docx2md — fflate-based .docx text extraction
// .docx files are ZIP archives. word/document.xml holds the body text in
// <w:t> (word-text) elements. We extract those, joining runs within the same
// paragraph (<w:p>) with no separator and paragraphs with newlines.
// ---------------------------------------------------------------------------
function extractTextFromDocx(inputPath: string): string {
  let raw: Buffer;
  try {
    raw = readFileSync(inputPath);
  } catch (e) {
    process.stderr.write(`Error reading ${inputPath}: ${(e as Error).message}\n`);
    process.exit(1);
  }

  let files: ReturnType<typeof unzipSync>;
  try {
    files = unzipSync(new Uint8Array(raw));
  } catch (e) {
    process.stderr.write(`Error unzipping ${inputPath}: ${(e as Error).message}\n`);
    process.exit(1);
  }

  const docXml = files["word/document.xml"];
  if (!docXml) {
    process.stderr.write(`Error: word/document.xml not found in ${inputPath}\n`);
    process.exit(1);
  }

  const xmlStr = new TextDecoder("utf-8").decode(docXml);

  // Extract paragraphs: split on <w:p[ >] ... </w:p>
  const lines: string[] = [];
  const paraRe = /<w:p[\s>][\s\S]*?<\/w:p>/g;
  let paraMatch: RegExpExecArray | null;

  while ((paraMatch = paraRe.exec(xmlStr)) !== null) {
    const para = paraMatch[0];
    // Extract all <w:t> text content within the paragraph
    const textRe = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
    let textMatch: RegExpExecArray | null;
    const parts: string[] = [];
    while ((textMatch = textRe.exec(para)) !== null) {
      parts.push(textMatch[1]);
    }
    const line = parts.join("").trim();
    if (line) lines.push(line);
  }

  return lines.join("\n");
}

async function docx2md(inputPath: string): Promise<void> {
  if (!existsSync(inputPath)) {
    process.stderr.write(`Error: input file not found: ${inputPath}\n`);
    process.exit(1);
  }

  const text = extractTextFromDocx(inputPath);
  process.stdout.write(text + "\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const [, , cmd, ...rest] = process.argv;

if (cmd === "md2docx") {
  const [input, output] = rest;
  if (!input || !output) {
    process.stderr.write("Usage: design-doc-cli.mjs md2docx <input.md> <output.docx>\n");
    process.exit(1);
  }
  md2docx(input, output).catch((e) => {
    process.stderr.write(`Unexpected error: ${(e as Error).message}\n`);
    process.exit(1);
  });
} else if (cmd === "docx2md") {
  const [input] = rest;
  if (!input) {
    process.stderr.write("Usage: design-doc-cli.mjs docx2md <input.docx>\n");
    process.exit(1);
  }
  docx2md(input).catch((e) => {
    process.stderr.write(`Unexpected error: ${(e as Error).message}\n`);
    process.exit(1);
  });
} else {
  process.stderr.write(
    "Usage:\n" +
      "  design-doc-cli.mjs md2docx <input.md> <output.docx>\n" +
      "  design-doc-cli.mjs docx2md <input.docx>\n"
  );
  process.exit(1);
}
