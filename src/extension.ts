/// <reference lib="dom" />

import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { InferenceClient } from '@huggingface/inference';
import { config } from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

config();

const HF_TOKEN = process.env.HF_TOKEN || 'your_token';
const client = new InferenceClient(HF_TOKEN);

const activeThreads = new Map<string, vscode.CommentThread>();

// Lines that should show a CodeLens
const pendingReasonKeys = new Set<string>();
// Lines already processed (avoid duplicates)
const processedLines = new Set<string>();

// Cache per-line Hint/Reasoning/Answer to avoid repeated API calls
type HRA = { 
  hint: string; 
  define: string; 
  answer: string; 
  fetched: boolean;
  hintOpened?: boolean;
  defineOpened?: boolean;
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
function parseHRA(raw: string): { hint: string; define: string; answer: string } {
  console.log('[IRA] Raw API response:', raw);
  
  if (!raw || typeof raw !== 'string') {
    console.log('[IRA] Invalid raw response:', raw);
    return { hint: 'No hint.', define: 'This line has a syntax error that needs to be fixed.', answer: 'No answer.' };
  }

  const hintMatch = raw.match(/^\s*Hint\s*:\s*(.*?)(?=^\s*Answer\s*:|$)/ims);
  const answerMatch = raw.match(/^\s*Answer\s*:\s*([\s\S]*)$/im);

  let hint = hintMatch?.[1]?.trim();
  let answer = answerMatch?.[1]?.trim();

  console.log('[IRA] Parsed matches:', { hint, answer });

  if (!hint || !answer) {
    // Fallback: line-based extraction
    const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const findLine = (prefix: string) =>
      lines.find(l => l.toLowerCase().startsWith(prefix))?.replace(/^.*?:\s*/i, '').trim();
    hint = hint || findLine('hint') || 'No hint.';
    answer = answer || findLine('answer') || 'No answer.';

    console.log('[IRA] Fallback parsing result:', { hint, answer });
  }

  // Normalize Answer to single-line "Original: ... → Corrected: ..."
  let answerText = answer
    .replace(/```[a-zA-Z]*\n?/g, '')
    .replace(/```/g, '')
    .trim();

  // Extract content after "Format:" up to the first quote
  const formatMatch = answerText.match(/Format\s*:\s*"([^"]*)/);
  if (formatMatch) {
    answerText = formatMatch[1];
  }

  let original = '';
  let corrected = '';
  const pair = answerText.match(/Original\s*:\s*([\s\S]*?)\s*→\s*Corrected\s*:\s*([\s\S]*?)\s*$/);
  if (pair) {
    original = pair[1].trim();
    corrected = pair[2].trim();
  } else {
    const lines = answerText.split(/\r?\n+/).map(s => s.trim()).filter(Boolean);
    if (lines.length >= 2) {
      original = lines[0];
      corrected = lines[1];
    } else if (lines.length === 1) {
      corrected = lines[0];
    }
  }

  const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
  original = collapse(original);
  corrected = collapse(corrected);

  const normalizedAnswer = `Original: ${original || '?'} → Corrected: ${corrected || '?'}`;

  return { 
    hint, 
    define: 'This line has a syntax error that needs to be fixed.', // Fixed define
    answer: normalizedAnswer 
  };
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
      define: hra.define,
      answer: hra.answer,
      hintOpened: hra.hintOpened || false,
      defineOpened: hra.defineOpened || false,
      answerOpened: hra.answerOpened || false
    };

    fs.writeFileSync(jsonPath, JSON.stringify(dataToSave, null, 2), 'utf8');
    console.log(`[IRA] Saved HRA data to: ${jsonPath}`);
  } catch (err) {
    console.error('[IRA] Failed to save HRA data:', err);
  }
}

// Save all HRA data for the current file to a local JSON file
async function saveAllHRADataForFile(uri: vscode.Uri) {
  const fileName = path.basename(uri.fsPath, path.extname(uri.fsPath));
  const dataDir = path.join('/Users/mikimizuki/IRA-frontend', 'ira-data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const jsonPath = path.join(dataDir, `${fileName}.json`);
  const allHRAData: { [key: string]: any } = {};

  // Collect all HRA data for this file
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
        define: hra.define,
        answer: hra.answer,
        hintOpened: hra.hintOpened || false,
        defineOpened: hra.defineOpened || false,
        answerOpened: hra.answerOpened || false,
        stepsCompleted: [
          hra.hintOpened && 'hint',
          hra.defineOpened && 'define', 
          hra.answerOpened && 'answer'
        ].filter(Boolean)
      };
    }
  }

  if (Object.keys(allHRAData).length > 0) {
    fs.writeFileSync(jsonPath, JSON.stringify(allHRAData, null, 2), 'utf8');
    console.log(`[IRA] Saved all HRA data for ${fileName} to: ${jsonPath}`);
  }
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
  console.log('[IRA] Querying model for code:', codeSnippet);
  
  const prompt =
`You are a concise and accurate Python assistant.

Analyze the following Python code and return your response in exactly this format:

Hint: <a one-sentence hint that guides the user toward the issue, without revealing the fix>
Answer: <show the original error line and the corrected line, format as: "Original: <error line> → Corrected: <fixed line>">

Respond with no extra explanation or formatting. Only include the 2 lines above.

Code:
[START]
\`\`\`python
${codeSnippet}
\`\`\`
[END]`;

  console.log('[IRA] Sending prompt:', prompt);

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
    
    console.log('[IRA] API response received:', result);
    return result;
  } catch (err) {
    console.error('[IRA] 🔥 Streaming fetch error:', err);
    return '';
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



  // Show Hint: display cached Hint
  context.subscriptions.push(
    vscode.commands.registerCommand('ida.showHintForLine', (uriStr: string, line: number) => {
      const uri = vscode.Uri.parse(uriStr);
      const k = keyFor(uri, line);
      const hra = hraCache.get(k);
      if (!hra) return;

      // Mark Hint as opened
      hra.hintOpened = true;
      hraCache.set(k, hra);

      const thread = activeThreads.get(uri.toString());
      if (!thread) return;

      // Rebuild comments: show Define, Hint, and provide Show Answer button
      thread.comments = [
        { mode: vscode.CommentMode.Preview, author: { name: 'IRA 🤖' }, body: new vscode.MarkdownString(`📚 **Define:** ${hra.define}`) },
        { mode: vscode.CommentMode.Preview, author: { name: 'IRA 🤖' }, body: new vscode.MarkdownString(`💡 **Hint:** ${hra.hint}`) },
        { mode: vscode.CommentMode.Preview, author: { name: 'IRA 🤖' }, body: cmdLink('👉 Show Answer', 'ida.showAnswerForLine', [uriStr, line]) }
      ];
    })
  );

  // Show Define: display cached Define and provide a "Show Answer" button
  context.subscriptions.push(
    vscode.commands.registerCommand('ida.showDefineForLine', (uriStr: string, line: number) => {
      const uri = vscode.Uri.parse(uriStr);
      const k = keyFor(uri, line);
      const hra = hraCache.get(k);
      if (!hra) return;

      // Mark Define as opened
      hra.defineOpened = true;
      hraCache.set(k, hra);
      // Not saving here; saving happens during file activation logic

      const thread = activeThreads.get(uri.toString());
      if (!thread) return;

      // Rebuild comments: keep Hint and Define, provide "Show Answer", remove "Show Define"
      thread.comments = [
        { mode: vscode.CommentMode.Preview, author: { name: 'IRA 🤖' }, body: new vscode.MarkdownString(`💡 **Hint:** ${hra.hint}`) },
        { mode: vscode.CommentMode.Preview, author: { name: 'IRA 🤖' }, body: new vscode.MarkdownString(`📚 **Define:** ${hra.define}`) },
        { mode: vscode.CommentMode.Preview, author: { name: 'IRA 🤖' }, body: cmdLink('👉 Show Answer', 'ida.showAnswerForLine', [uriStr, line]) }
      ];
    })
  );

  // Show Answer: display Answer and mark this line as processed
  context.subscriptions.push(
    vscode.commands.registerCommand('ida.showAnswerForLine', async (uriStr: string, line: number) => {
      const uri = vscode.Uri.parse(uriStr);
      const k = keyFor(uri, line);
      const hra = hraCache.get(k);
      if (!hra) return;

      // Mark Answer as opened
      hra.answerOpened = true;
      hraCache.set(k, hra);
      
      // Not saving here; saving happens during file activation logic

      // Rebuild comments: show the final Answer and remove buttons
      const thread = activeThreads.get(uri.toString());
      if (!thread) return;
      thread.comments = [
        { mode: vscode.CommentMode.Preview, author: { name: 'IRA 🤖' }, body: new vscode.MarkdownString(`📚 **Define:** ${hra.define}`) },
        { mode: vscode.CommentMode.Preview, author: { name: 'IRA 🤖' }, body: new vscode.MarkdownString(`💡 **Hint:** ${hra.hint}`) },
        { mode: vscode.CommentMode.Preview, author: { name: 'IRA 🤖' }, body: new vscode.MarkdownString(`✅ **Answer:**\n\n${hra.answer}`) }
      ];

      processedLines.add(k);
      
      // Auto-save when user completes the full flow
      saveAllHRADataForFile(uri);
      console.log('[IRA] Auto-saved HRA data after showing Answer');
    })
  );



  // Helper function to create comment thread directly
  async function createCommentThreadForLine(uri: vscode.Uri, line: number) {
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

    // Show loading state immediately
    thread.comments = [
      {
        mode: vscode.CommentMode.Preview,
        author: { name: 'IRA 🤖' },
        body: new vscode.MarkdownString('🤖 **AI is generating...**')
      }
    ];

    // Start model request immediately
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const codeLine = doc.lineAt(line).text;
      const fullText = await queryModelStream(codeLine);
      
      if (!fullText) {
        thread.comments = [
          {
            mode: vscode.CommentMode.Preview,
            author: { name: 'IRA 🤖' },
            body: new vscode.MarkdownString('❌ **Failed to get response from model.**')
          }
        ];
        // Mark this line as processed even on failure
        processedLines.add(k);
        console.log(`[IRA] Line ${line + 1} marked as processed (failure). processedLines size: ${processedLines.size}`);
        return;
      }
      
      const parsed = parseHRA(fullText);
      const hra = { ...parsed, fetched: true, hintOpened: false, defineOpened: true, answerOpened: false };
      hraCache.set(k, hra);

      // Display Define with Show Hint button only
      thread.comments = [
        { mode: vscode.CommentMode.Preview, author: { name: 'IRA 🤖' }, body: new vscode.MarkdownString(`📚 **Define:** ${hra.define}`) },
        { mode: vscode.CommentMode.Preview, author: { name: 'IRA 🤖' }, body: cmdLink('👉 Show Hint', 'ida.showHintForLine', [uri.toString(), line]) }
      ];

      // Mark this line as processed
      processedLines.add(k);
      console.log(`[IRA] Line ${line + 1} marked as processed. processedLines size: ${processedLines.size}`);

    } catch (e) {
      console.error('[IRA] Model request error:', e);
      thread.comments = [
        {
          mode: vscode.CommentMode.Preview,
          author: { name: 'IRA 🤖' },
          body: new vscode.MarkdownString('❌ **Error occurred while generating response.**')
        }
      ];
      // Mark this line as processed even on error
      processedLines.add(k);
      console.log(`[IRA] Line ${line + 1} marked as processed (error). processedLines size: ${processedLines.size}`);
    }
  }

  // Webview (capture error line -> tag -> show CodeLens)
  const panel = vscode.window.createWebviewPanel('iraChat', 'IRA Chat', vscode.ViewColumn.Two, { enableScripts: true });
  panel.webview.html = getWebviewContent();

  panel.webview.onDidReceiveMessage(async msg => {
    if (msg.command === 'enableHint') {
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
            // Instead of showing CodeLens, directly create comment thread
            await createCommentThreadForLine(doc.uri, errorLine - 1);
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



export function deactivate() {}
