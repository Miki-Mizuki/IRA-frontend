/// <reference lib="dom" />

import * as vscode from 'vscode';
import { spawn } from 'child_process';

let isHintEnabled = false;
const activeThreads = new Map<string, vscode.CommentThread>();
const processedLines = new Set<string>(); // Track processed lines

export function activate(context: vscode.ExtensionContext) {
  console.log('[IRA] Extension is active!');

  const commentController = vscode.comments.createCommentController('ira.comments', 'IRA Review');
  context.subscriptions.push(commentController);

  context.subscriptions.push(
    vscode.commands.registerCommand('ida.addComment', async (uri: vscode.Uri, line: number) => {
      const doc = await vscode.workspace.openTextDocument(uri);
      const codeLine = doc.lineAt(line).text;

      const thread = commentController.createCommentThread(
        uri,
        new vscode.Range(line, 0, line, 0),
        []
      );
      thread.canReply = false;

      const loading = new vscode.MarkdownString(`Analyzing with AI... Please wait.`);
      loading.isTrusted = true;
      thread.comments = [
        {
          mode: vscode.CommentMode.Preview,
          author: { name: 'IRA 🤖' },
          body: loading
        }
      ];
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      activeThreads.set(uri.toString(), thread);

      const reasoning = await queryModel(codeLine);

      const result = new vscode.MarkdownString(reasoning);
      result.isTrusted = true;
      thread.comments = [
        {
          mode: vscode.CommentMode.Preview,
          author: { name: 'IRA 🤖' },
          body: result
        }
      ];

      processedLines.add(`${uri.toString()}:${line}`); //  Add to processed lines
      vscode.commands.executeCommand('vscode.executeCodeLensProvider', uri); //  Refresh CodeLens with URI
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ida.fullFix', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const uri = editor.document.uri;
      const thread = activeThreads.get(uri.toString());
      if (!thread) {
        vscode.window.showWarningMessage('No active IRA comment thread found.');
        return;
      }

      thread.comments = [
        ...thread.comments,
        {
          mode: vscode.CommentMode.Preview,
          author: { name: 'IRA 🤖' },
          body: new vscode.MarkdownString(`
**✅ Full Fix:** Try fixing the syntax or install missing modules. Run:

\`\`\`bash
pip install <your-package>
\`\`\`
          `)
        }
      ];
    })
  );

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ language: 'python' }, {
      provideCodeLenses(document, token) {
        const lenses: vscode.CodeLens[] = [];
        for (let i = 0; i < document.lineCount; i++) {
          const key = `${document.uri.toString()}:${i}`;
          if (processedLines.has(key)) continue;

          const hasComment = [...activeThreads.values()].some(thread =>
            thread.uri.toString() === document.uri.toString() &&
            thread.range &&
            thread.range.start.line === i
          );

          if (hasComment) {
            lenses.push(new vscode.CodeLens(
              new vscode.Range(i, 0, i, 0),
              {
                title: '🔍 Give me reasoning',
                command: 'ida.addComment',
                arguments: [document.uri, i]
              }
            ));
          }
        }
        return lenses;
      }
    })
  );

  const panel = vscode.window.createWebviewPanel(
    'iraChat',
    'IRA Chat',
    vscode.ViewColumn.Two,
    { enableScripts: true }
  );
  panel.webview.html = getWebviewContent();

  panel.webview.onDidReceiveMessage(
    async msg => {
      console.log('[IRA] Received message from Webview:', msg);

      if (msg.command === 'enableHint') {
        isHintEnabled = true;
        vscode.window.showInformationMessage('IRA is watching for runtime errors...');

        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showWarningMessage('No active editor.');
          return;
        }

        const filePath = editor.document.uri.fsPath;
        if (!filePath.endsWith('.py')) {
          vscode.window.showWarningMessage('This file is not a Python file.');
          return;
        }

        vscode.window.showInformationMessage(`Running: ${filePath}`);

        const proc = spawn('python3', [filePath]);

        proc.stdout.on('data', data => {
          console.log('[IRA STDOUT]', data.toString());
        });

        proc.stderr.on('data', async (data: Buffer) => {
          const text = data.toString();
          console.log('[IRA STDERR]', text);

          const match = text.match(/File \"(.+\.py)\", line (\d+)/);
          if (!match) {
            console.warn('[IRA] Could not extract error line.');
            return;
          }

          const errorFile = match[1];
          const errorLine = parseInt(match[2], 10);
          try {
            const doc = await vscode.workspace.openTextDocument(errorFile);
            await vscode.window.showTextDocument(doc, {
              viewColumn: vscode.ViewColumn.Active,
              preserveFocus: false,
              preview: false
            });
            vscode.commands.executeCommand('ida.addComment', doc.uri, errorLine - 1);
          } catch (err) {
            console.error('[IRA] Failed to open error location:', err);
          }
        });

        proc.on('close', code => {
          console.log(`[IRA] Python process exited with code ${code}`);
        });
      }
    },
    undefined,
    context.subscriptions
  );
}

function getWebviewContent() {
  return `<!DOCTYPE html>
<html>
  <body style="background-color: #1e1e1e; color: white; padding: 1em; font-family: sans-serif;">
    <h2>🤖 IRA</h2>
    <p>Don't panic! We've seen this before.<br>Shall we go through it together?</p>
    <button onclick="enableHint()">Yes please</button>
    <button>No thank you</button>
    <script>
      const vscode = acquireVsCodeApi();
      function enableHint() {
        vscode.postMessage({ command: 'enableHint' });
      }
    </script>
  </body>
</html>`;
}

async function queryModel(errorCode: string): Promise<string> {
  const { default: fetch } = await import('node-fetch');
  const HF_TOKEN = ''; // Replace with your HuggingFace token
  const API_URL = 'https://router.huggingface.co/v1/chat/completions';

  const payload = {
    model: 'nvidia/OpenReasoning-Nemotron-32B:featherless-ai',
    messages: [
      {
        role: 'user',
        content: `Please explain the following Python code, identify any syntax or logic errors, and suggest a corrected version:\n\n\u0060\u0060\u0060python\n${errorCode}\n\u0060\u0060\u0060`
      }
    ]
  };

  try {
    console.log('[IRA] 🔄 Sending request to HF...');
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${HF_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    console.log(`[IRA] Response status: ${res.status} ${res.statusText}`);
    const text = await res.text();
    console.log('[IRA] Raw response text:\n', text);

    let json: any;
    try {
      json = JSON.parse(text);
    } catch (parseError) {
      console.error('[IRA]  Failed to parse JSON:', parseError);
      return ' Response was not valid JSON.';
    }

    const content = json?.choices?.[0]?.message?.content;
    return content || ' No response content from model.';
  } catch (err) {
    console.error('[IRA]  fetch error:', err);
    return ' Error occurred while contacting HuggingFace model.';
  }
}

export function deactivate() {}