/// <reference lib="dom" />

import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { InferenceClient } from '@huggingface/inference';
import { config } from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

config();

const HF_TOKEN = process.env.HF_TOKEN || '***REMOVED***';
const client = new InferenceClient(HF_TOKEN);

let isHintEnabled = false;
const activeThreads = new Map<string, vscode.CommentThread>();

// Lines that should show a CodeLens
const pendingReasonKeys = new Set<string>();
// Lines already processed (avoid duplicates)
const processedLines = new Set<string>();

// Cache per-line Hint/Reasoning/Answer to avoid repeated API calls
type HRA = { 
  hint: string; 
  reasoning: string; 
  answer: string; 
  fetched: boolean;
  hintOpened?: boolean;
  reasoningOpened?: boolean;
  answerOpened?: boolean;
};
const hraCache = new Map<string, HRA>();

function keyFor(uri: vscode.Uri, line: number) {
  return `${uri.toString()}:${line}`;
}

// Build a VS Code command link (args are JSON+URI encoded)
function cmdLink(title: string, command: string, args: unknown[]): vscode.MarkdownString {
  const ms = new vscode.MarkdownString(
    `[${title}](command:${command}?${encodeURIComponent(JSON.stringify(args))})`
  );
  ms.isTrusted = true;
  return ms;
}

// Parse the model output (more robust)
function parseHRA(raw: string): { hint: string; reasoning: string; answer: string } {
  console.log('[IRA] Raw API response:', raw); // 调试日志
  
  if (!raw || typeof raw !== 'string') {
    console.log('[IRA] Invalid raw response:', raw); // 调试日志
    return { hint: 'No hint.', reasoning: 'No reasoning.', answer: 'No answer.' };
  }

  const hintMatch = raw.match(/^\s*Hint\s*:\s*(.*?)(?=^\s*Reasoning\s*:|^\s*Answer\s*:|$)/ims);
  const reasoningMatch = raw.match(/^\s*Reasoning\s*:\s*(.*?)(?=^\s*Answer\s*:|$)/ims);
  const answerMatch = raw.match(/^\s*Answer\s*:\s*([\s\S]*)$/im);

  let hint = hintMatch?.[1]?.trim();
  let reasoning = reasoningMatch?.[1]?.trim();
  let answer = answerMatch?.[1]?.trim();

  console.log('[IRA] Parsed matches:', { hint, reasoning, answer }); // 调试日志

  if (!hint || !reasoning || !answer) {
    // Fallback: line-based extraction
    const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const findLine = (prefix: string) =>
      lines.find(l => l.toLowerCase().startsWith(prefix))?.replace(/^.*?:\s*/i, '').trim();
    hint = hint || findLine('hint') || 'No hint.';
    reasoning = reasoning || findLine('reasoning') || 'No reasoning.';
    answer = answer || findLine('answer') || 'No answer.';
    
    console.log('[IRA] Fallback parsing result:', { hint, reasoning, answer }); // 调试日志
  }

  // Wrap Answer in a code block for clarity
  if (!/```/.test(answer)) {
    answer = `\`\`\`python\n${answer}\n\`\`\``;
  }

  return { hint, reasoning, answer };
}

// Save HRA data to a local JSON file
function saveHRAToFile(uri: vscode.Uri, line: number, hra: HRA) {
  try {
    // Use the project-level ira-data directory
    const dataDir = path.join('/Users/mikimizuki/IRA-frontend', 'ira-data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const fileName = path.basename(uri.fsPath, path.extname(uri.fsPath));
    const jsonPath = path.join(dataDir, `${fileName}_line_${line + 1}.json`);
    
    const dataToSave = {
      file: uri.fsPath,
      line: line + 1,
      timestamp: new Date().toISOString(),
      hint: hra.hint,
      reasoning: hra.reasoning,
      answer: hra.answer,
      hintOpened: hra.hintOpened || false,
      reasoningOpened: hra.reasoningOpened || false,
      answerOpened: hra.answerOpened || false
    };

    fs.writeFileSync(jsonPath, JSON.stringify(dataToSave, null, 2), 'utf8');
    console.log(`[IRA] Saved HRA data to: ${jsonPath}`);
  } catch (err) {
    console.error('[IRA] Failed to save HRA data:', err);
  }
}

export function activate(context: vscode.ExtensionContext) {
  console.log('[IRA] Extension is active!');

  const commentController = vscode.comments.createCommentController('ira.comments', 'IRA Review');
  context.subscriptions.push(commentController);

  // When a Python file becomes active, opportunistically save HRA data
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      if (editor && editor.document.uri.fsPath.endsWith('.py')) {
        // On switching to a Python file, check if there is HRA data to save
        const currentUri = editor.document.uri;
        const hasHRAData = Array.from(hraCache.keys()).some(key => {
          const match = key.match(/^(.+):(\d+)$/);
          if (!match) return false;
          return vscode.Uri.parse(match[1]).fsPath === currentUri.fsPath;
        });
        
        if (hasHRAData) {
          console.log('[IRA] Python file activated, checking for HRA data to save...');
          // Delay slightly to avoid blocking UX
          setTimeout(async () => {
            await saveAllHRADataForFile(currentUri);
          }, 1000);
        }
      }
    })
  );

  // Command: manually save HRA data
  context.subscriptions.push(
    vscode.commands.registerCommand('ida.saveHRAData', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage('No active editor.');
        return;
      }
      
      await saveAllHRADataForFile(editor.document.uri);
      vscode.window.showInformationMessage('HRA data saved successfully!');
    })
  );

  // On CodeLens click: create thread and buttons only (no model request yet)
  context.subscriptions.push(
    vscode.commands.registerCommand('ida.addComment', async (uri: vscode.Uri, line: number) => {
      const k = keyFor(uri, line);
      if (processedLines.has(k)) {
        vscode.window.showInformationMessage('Already explained for this line.');
        return;
      }

      const thread = commentController.createCommentThread(
        uri,
        new vscode.Range(line, 0, line, 0),
        []
      );
      thread.canReply = false;
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      activeThreads.set(uri.toString(), thread);

      // Initially show only the "Show Hint" button
      thread.comments = [
        {
          mode: vscode.CommentMode.Preview,
          author: { name: 'IRA 🤖' },
          body: cmdLink('👉 Show Hint', 'ida.showHintForLine', [uri.toString(), line])
        }
      ];

      // Prefetch asynchronously after CodeLens click (non-blocking)
      (async () => {
        try {
          const existing = hraCache.get(k);
          if (existing?.fetched) return;
          const doc = await vscode.workspace.openTextDocument(uri);
          const codeLine = doc.lineAt(line).text;
          const fullText = await queryModelStream(codeLine);
          if (!fullText) return;
          const parsed = parseHRA(fullText);
          const hra = { ...parsed, fetched: true, hintOpened: false, reasoningOpened: false, answerOpened: false };
          hraCache.set(k, hra);
          // 不立即保存，等到用户再次运行 Python 文件时再保存
        } catch (e) {
          console.error('[IRA] Prefetch error:', e);
        }
      })();
    })
  );

  // Show Hint: fetch once if needed and cache, then display Hint and a "Show Reasoning" button
  context.subscriptions.push(
    vscode.commands.registerCommand('ida.showHintForLine', async (uriStr: string, line: number) => {
      const uri = vscode.Uri.parse(uriStr);
      const k = keyFor(uri, line);

      let hra = hraCache.get(k);
      if (!hra || !hra.fetched) {
        // First fetch
        const doc = await vscode.workspace.openTextDocument(uri);
        const codeLine = doc.lineAt(line).text;
        const fullText = await queryModelStream(codeLine);
        if (!fullText) {
          vscode.window.showErrorMessage('Failed to get response from model.');
          return;
        }
        const parsed = parseHRA(fullText);
        hra = { ...parsed, fetched: true, hintOpened: false, reasoningOpened: false, answerOpened: false };
        hraCache.set(k, hra);
        // Do not save here; defer saving until the user finishes the flow
      }

      // 标记 Hint 已打开
      hra.hintOpened = true;
      hraCache.set(k, hra);
      // 不立即保存，等到用户"用完"功能时再保存

      const thread = activeThreads.get(uri.toString());
      if (!thread) return;

      // Rebuild comments: keep Hint and provide a "Show Reasoning" button
      thread.comments = [
        { mode: vscode.CommentMode.Preview, author: { name: 'IRA 🤖' }, body: new vscode.MarkdownString(`💡 **Hint:** ${hra.hint}`) },
        { mode: vscode.CommentMode.Preview, author: { name: 'IRA 🤖' }, body: cmdLink('👉 Show Reasoning', 'ida.showReasoningForLine', [uriStr, line]) }
      ];
    })
  );

  // Show Reasoning: display cached Reasoning and provide a "Show Answer" button
  context.subscriptions.push(
    vscode.commands.registerCommand('ida.showReasoningForLine', (uriStr: string, line: number) => {
      const uri = vscode.Uri.parse(uriStr);
      const k = keyFor(uri, line);
      const hra = hraCache.get(k);
      if (!hra) return;

      // Mark Reasoning as opened
      hra.reasoningOpened = true;
      hraCache.set(k, hra);
      // 不立即保存，等到用户"用完"功能时再保存

      const thread = activeThreads.get(uri.toString());
      if (!thread) return;

      // Rebuild comments: keep Hint and Reasoning, provide "Show Answer", remove "Show Reasoning"
      thread.comments = [
        { mode: vscode.CommentMode.Preview, author: { name: 'IRA 🤖' }, body: new vscode.MarkdownString(`💡 **Hint:** ${hra.hint}`) },
        { mode: vscode.CommentMode.Preview, author: { name: 'IRA 🤖' }, body: new vscode.MarkdownString(`🧠 **Reasoning:** ${hra.reasoning}`) },
        { mode: vscode.CommentMode.Preview, author: { name: 'IRA 🤖' }, body: cmdLink('👉 Show Answer', 'ida.showAnswerForLine', [uriStr, line]) }
      ];
    })
  );

  // Show Answer: display Answer and mark this line as processed
  context.subscriptions.push(
    vscode.commands.registerCommand('ida.showAnswerForLine', (uriStr: string, line: number) => {
      const uri = vscode.Uri.parse(uriStr);
      const k = keyFor(uri, line);
      const hra = hraCache.get(k);
      if (!hra) return;

      // Mark Answer as opened
      hra.answerOpened = true;
      hraCache.set(k, hra);
      
      // Not saving here; saving happens when the user presses Done or during file activation logic
      // saveHRAToFile(uri, line, hra); // This line is removed

      // Rebuild comments: show the final Answer and remove buttons
      const thread = activeThreads.get(uri.toString());
      if (!thread) return;
      thread.comments = [
        { mode: vscode.CommentMode.Preview, author: { name: 'IRA 🤖' }, body: new vscode.MarkdownString(`💡 **Hint:** ${hra.hint}`) },
        { mode: vscode.CommentMode.Preview, author: { name: 'IRA 🤖' }, body: new vscode.MarkdownString(`🧠 **Reasoning:** ${hra.reasoning}`) },
        { mode: vscode.CommentMode.Preview, author: { name: 'IRA 🤖' }, body: new vscode.MarkdownString(`✅ **Answer:**\n\n${hra.answer}`) }
      ];

      processedLines.add(k);
    })
  );

  // Only show a CodeLens on lines pending explanation
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ language: 'python' }, {
      provideCodeLenses(document) {
        const lenses: vscode.CodeLens[] = [];
        for (let i = 0; i < document.lineCount; i++) {
          const k = keyFor(document.uri, i);
          if (pendingReasonKeys.has(k) && !processedLines.has(k)) {
            lenses.push(new vscode.CodeLens(
              new vscode.Range(i, 0, i, 0),
              { title: '🔍 Give me reasoning', command: 'ida.addComment', arguments: [document.uri, i] }
            ));
          }
        }
        return lenses;
      }
    })
  );

  // Webview (capture error line -> tag -> show CodeLens)
  const panel = vscode.window.createWebviewPanel('iraChat', 'IRA Chat', vscode.ViewColumn.Two, { enableScripts: true });
  panel.webview.html = getWebviewContent();

  panel.webview.onDidReceiveMessage(async msg => {
    if (msg.command === 'enableHint') {
      isHintEnabled = true;
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const filePath = editor.document.uri.fsPath;
      if (!filePath.endsWith('.py')) return;

      // Saving is handled elsewhere; this just runs the file

      const proc = spawn('python3', [filePath]);

      proc.stderr.on('data', async (data: Buffer) => {
        const text = data.toString();
        const match = text.match(/File \"(.+\.py)\", line (\d+)/);
        if (!match) return;

        const errorFile = match[1];
        const errorLine = parseInt(match[2], 10);

        try {
          const doc = await vscode.workspace.openTextDocument(errorFile);
          await vscode.window.showTextDocument(doc);

          const k = keyFor(doc.uri, errorLine - 1);
          if (!processedLines.has(k)) {
            pendingReasonKeys.add(k);
            vscode.commands.executeCommand('vscode.executeCodeLensProvider', doc.uri);
          }
        } catch (err) {
          console.error('[IRA] Failed to open error location:', err);
        }
      });

      proc.on('close', code => {
        console.log(`[IRA] Python process exited with code ${code}`);
      });
    }
  }, undefined, context.subscriptions);
}

function getWebviewContent() {
  return `<!DOCTYPE html>
  <html><body style="background:#1e1e1e;color:white;padding:1em;font-family:sans-serif">
  <h2>🤖 IRA</h2>
  <p>Don't panic! We've seen this before.<br>Shall we go through it together?</p>
  <button onclick="enableHint()">Yes please</button>
  <script>
    const vscode = acquireVsCodeApi();
    function enableHint() { vscode.postMessage({ command: 'enableHint' }); }
  </script>
  </body></html>`;
}

// Model: fetch once via streaming and display step-by-step
async function queryModelStream(codeSnippet: string): Promise<string> {
  console.log('[IRA] Querying model for code:', codeSnippet); // 调试日志
  
  const prompt =
`You are a concise and accurate Python assistant.

Analyze the following Python code and return your response in exactly this format:

Hint: <a one-sentence hint that guides the user toward the issue, without revealing the fix>
Reasoning: <a brief explanation of what the error is and why it happens, without including the fix>
Answer: <the corrected line of Python code only>

Respond with no extra explanation or formatting. Only include the 3 lines above.

Code:
[START]
\`\`\`python
${codeSnippet}
\`\`\`
[END]`;

  console.log('[IRA] Sending prompt:', prompt); // 调试日志

  let result = '';
  try {
    const stream = await client.chatCompletionStream({
      provider: 'featherless-ai',
      model: 'nvidia/OpenReasoning-Nemotron-32B',
      temperature: 0,
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }]
    });

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) result += delta;
    }
    
    console.log('[IRA] API response received:', result); // 调试日志
    return result;
  } catch (err) {
    console.error('[IRA] 🔥 Streaming fetch error:', err);
    return '';
  }
}

// Save all HRA data for the current file to a local JSON file
// Save whatever steps the user has opened so far (Hint/Reasoning/Answer)
async function saveAllHRADataForFile(uri: vscode.Uri) {
  const fileName = path.basename(uri.fsPath, path.extname(uri.fsPath));
  const dataDir = path.join('/Users/mikimizuki/IRA-frontend', 'ira-data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const jsonPath = path.join(dataDir, `${fileName}.json`);
  const allHRAData: { [key: string]: any } = {};

  // Collect all HRA data for this file (regardless of how many steps were opened)
  for (const [key, hra] of hraCache.entries()) {
    const match = key.match(/^(.+):(\d+)$/);
    if (!match) continue;
    const uriStr = match[1];
    const line = parseInt(match[2], 10);

    if (vscode.Uri.parse(uriStr).fsPath === uri.fsPath) {
      allHRAData[key] = {
        file: uri.fsPath,
        line: line + 1,
        timestamp: new Date().toISOString(),
        hint: hra.hint,
        reasoning: hra.reasoning,
        answer: hra.answer,
        hintOpened: hra.hintOpened || false,
        reasoningOpened: hra.reasoningOpened || false,
        answerOpened: hra.answerOpened || false,
        // Record which steps the user actually opened
        stepsCompleted: [
          hra.hintOpened && 'hint',
          hra.reasoningOpened && 'reasoning', 
          hra.answerOpened && 'answer'
        ].filter(Boolean)
      };
    }
  }

  if (Object.keys(allHRAData).length > 0) {
    fs.writeFileSync(jsonPath, JSON.stringify(allHRAData, null, 2), 'utf8');
    console.log(`[IRA] Saved all HRA data for ${fileName} to: ${jsonPath}`);
    console.log(`[IRA] User completed steps:`, Object.values(allHRAData).map(d => d.stepsCompleted));
  } else {
    // If there is no data, delete the empty file
    if (fs.existsSync(jsonPath)) {
      fs.unlinkSync(jsonPath);
      console.log(`[IRA] Deleted empty HRA data file for ${fileName}: ${jsonPath}`);
    }
  }
}

export function deactivate() {}


