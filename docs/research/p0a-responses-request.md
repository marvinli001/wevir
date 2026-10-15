# P0a Responses 上游请求验收样本

2026-10-15：锁定的 `codex-app-server rust-v0.162.1` 录制样本 `1-first-turn`，经构建后的产品网关发到本机 HTTP mock，`compat: {toolChoice: "auto_only", supportsNamespaceTools: false}`。这里只贴上游实际收到的 `tools` 与 `tool_choice`；各级 description 超过 160 字符的截断，其余工具参数与 Lark 语法保留。不含输入正文、请求头、令牌或 Key。

custom 的全局默认是支持，因此 apply_patch 仍是 custom；不支持 custom 的服务要另设 `supportsCustomTools: false`。命名空间工具已摊平成 multi_agent_v1__…；tool_choice 为 auto。

```json
{
  "tools": [
    {
      "type": "function",
      "name": "exec_command",
      "description": "Runs a command in a PTY, returning output or a session ID for ongoing interaction.",
      "strict": false,
      "parameters": {
        "type": "object",
        "properties": {
          "cmd": {
            "type": "string",
            "description": "Shell command to execute."
          },
          "justification": {
            "type": "string",
            "description": "User-facing approval question for `require_escalated`; omit otherwise."
          },
          "login": {
            "type": "boolean",
            "description": "True runs the shell with -l/-i semantics; false disables them. Defaults to true."
          },
          "max_output_tokens": {
            "type": "number",
            "description": "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy."
          },
          "prefix_rule": {
            "type": "array",
            "description": "Reusable approval prefix for `cmd`, only with `sandbox_permissions: \"require_escalated\"`; for example [\"git\", \"pull\"].",
            "items": {
              "type": "string"
            }
          },
          "sandbox_permissions": {
            "type": "string",
            "description": "Per-command sandbox override. Defaults to `use_default`; use `require_escalated` for unsandboxed execution.",
            "enum": [
              "use_default",
              "require_escalated"
            ]
          },
          "shell": {
            "type": "string",
            "description": "Shell binary to launch. Defaults to the user's default shell."
          },
          "tty": {
            "type": "boolean",
            "description": "True allocates a PTY for the command; false or omitted uses plain pipes."
          },
          "workdir": {
            "type": "string",
            "description": "Working directory for the command. Defaults to the turn cwd."
          },
          "yield_time_ms": {
            "type": "number",
            "description": "Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms."
          }
        },
        "required": [
          "cmd"
        ],
        "additionalProperties": false
      }
    },
    {
      "type": "function",
      "name": "write_stdin",
      "description": "Writes characters to an existing unified exec session and returns recent output.",
      "strict": false,
      "parameters": {
        "type": "object",
        "properties": {
          "chars": {
            "type": "string",
            "description": "Bytes to write to stdin. Defaults to empty, which polls without writing."
          },
          "max_output_tokens": {
            "type": "number",
            "description": "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy."
          },
          "session_id": {
            "type": "number",
            "description": "Identifier of the running unified exec session."
          },
          "yield_time_ms": {
            "type": "number",
            "description": "Wait before yielding output. Non-empty writes default to 250 ms and cap at 30000 ms; empty polls wait 5000-300000 ms by default."
          }
        },
        "required": [
          "session_id"
        ],
        "additionalProperties": false
      }
    },
    {
      "type": "function",
      "name": "request_user_input",
      "description": "Request user input for one to three short questions and wait for the response. This tool is only available in Plan mode.",
      "strict": false,
      "parameters": {
        "type": "object",
        "properties": {
          "questions": {
            "type": "array",
            "description": "Questions to show the user. Prefer 1 and do not exceed 3",
            "items": {
              "type": "object",
              "properties": {
                "header": {
                  "type": "string",
                  "description": "Short header label shown in the UI (12 or fewer chars)."
                },
                "id": {
                  "type": "string",
                  "description": "Stable identifier for mapping answers (snake_case)."
                },
                "options": {
                  "type": "array",
                  "description": "Provide 2-3 mutually exclusive choices. Put the recommended option first and suffix its label with \"(Recommended)\". Do not include an \"Other\" option in this lis…（描述截断）",
                  "items": {
                    "type": "object",
                    "properties": {
                      "description": {
                        "type": "string",
                        "description": "One short sentence explaining impact/tradeoff if selected."
                      },
                      "label": {
                        "type": "string",
                        "description": "User-facing label (1-5 words)."
                      }
                    },
                    "required": [
                      "label",
                      "description"
                    ],
                    "additionalProperties": false
                  }
                },
                "question": {
                  "type": "string",
                  "description": "Single-sentence prompt shown to the user."
                }
              },
              "required": [
                "id",
                "header",
                "question",
                "options"
              ],
              "additionalProperties": false
            }
          }
        },
        "required": [
          "questions"
        ],
        "additionalProperties": false
      }
    },
    {
      "type": "custom",
      "name": "apply_patch",
      "description": "The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
      "format": {
        "type": "grammar",
        "syntax": "lark",
        "definition": "start: begin_patch hunk+ end_patch\nbegin_patch: \"*** Begin Patch\" LF\nend_patch: \"*** End Patch\" LF?\n\nhunk: add_hunk | delete_hunk | update_hunk\nadd_hunk: \"*** Add File: \" filename LF add_line+\ndelete_hunk: \"*** Delete File: \" filename LF\nupdate_hunk: \"*** Update File: \" filename LF change_move? change?\n\nfilename: /(.+)/\nadd_line: \"+\" /(.*)/ LF -> line\n\nchange_move: \"*** Move to: \" filename LF\nchange: (change_context | change_line)+ eof_line?\nchange_context: (\"@@\" | \"@@ \" /(.+)/) LF\nchange_line: (\"+\" | \"-\" | \" \") /(.*)/ LF\neof_line: \"*** End of File\" LF\n\n%import common.LF\n"
      }
    },
    {
      "type": "function",
      "name": "view_image",
      "description": "View a local image file from the filesystem when visual inspection is needed. Use this for images already available on disk.",
      "strict": false,
      "parameters": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "Local filesystem path to an image file."
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      }
    },
    {
      "type": "function",
      "name": "multi_agent_v1__close_agent",
      "description": "Close an agent and any open descendants when they are no longer needed, and return the target agent's previous status before shutdown was requested. Completed a…（描述截断）",
      "strict": false,
      "parameters": {
        "type": "object",
        "properties": {
          "target": {
            "type": "string",
            "description": "Agent id to close (from spawn_agent)."
          }
        },
        "required": [
          "target"
        ],
        "additionalProperties": false
      }
    },
    {
      "type": "function",
      "name": "multi_agent_v1__resume_agent",
      "description": "Resume a previously closed agent by id so it can receive send_input and wait_agent calls.",
      "strict": false,
      "parameters": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "description": "Agent id to resume."
          }
        },
        "required": [
          "id"
        ],
        "additionalProperties": false
      }
    },
    {
      "type": "function",
      "name": "multi_agent_v1__send_input",
      "description": "Send a message to an existing agent. Use interrupt=true to redirect work immediately. You should reuse the agent by send_input if you believe your assigned task…（描述截断）",
      "strict": false,
      "parameters": {
        "type": "object",
        "properties": {
          "interrupt": {
            "type": "boolean",
            "description": "True interrupts the current task and handles this message immediately; false or omitted queues it."
          },
          "items": {
            "type": "array",
            "description": "Structured input items. Use this to pass explicit mentions (for example app:// connector paths).",
            "items": {
              "type": "object",
              "properties": {
                "audio_url": {
                  "type": "string",
                  "description": "Audio data URL when type is audio."
                },
                "image_url": {
                  "type": "string",
                  "description": "Image URL when type is image."
                },
                "name": {
                  "type": "string",
                  "description": "Display name when type is skill or mention."
                },
                "path": {
                  "type": "string",
                  "description": "Path when type is local_image/local_audio/skill, or structured mention target such as app://<connector-id> or plugin://<plugin-name>@<marketplace-name> when typ…（描述截断）"
                },
                "text": {
                  "type": "string",
                  "description": "Text content when type is text."
                },
                "type": {
                  "type": "string",
                  "description": "Input item type: text, image, local_image, audio, local_audio, skill, or mention."
                }
              },
              "additionalProperties": false
            }
          },
          "message": {
            "type": "string",
            "description": "Legacy plain-text message to send to the agent. Use either message or items."
          },
          "target": {
            "type": "string",
            "description": "Agent id to message (from spawn_agent)."
          }
        },
        "required": [
          "target"
        ],
        "additionalProperties": false
      }
    },
    {
      "type": "function",
      "name": "multi_agent_v1__spawn_agent",
      "description": "\n        \n        Available model overrides (optional; inherited parent model is preferred):\n- `wevir-mock`: Wevir spike mock model Reasoning efforts: low, high…（描述截断）",
      "strict": false,
      "parameters": {
        "type": "object",
        "properties": {
          "fork_context": {
            "type": "boolean",
            "description": "True forks the current thread history into the new agent; false or omitted starts with only the initial prompt."
          },
          "items": {
            "type": "array",
            "description": "Structured input items. Use this to pass explicit mentions (for example app:// connector paths).",
            "items": {
              "type": "object",
              "properties": {
                "audio_url": {
                  "type": "string",
                  "description": "Audio data URL when type is audio."
                },
                "image_url": {
                  "type": "string",
                  "description": "Image URL when type is image."
                },
                "name": {
                  "type": "string",
                  "description": "Display name when type is skill or mention."
                },
                "path": {
                  "type": "string",
                  "description": "Path when type is local_image/local_audio/skill, or structured mention target such as app://<connector-id> or plugin://<plugin-name>@<marketplace-name> when typ…（描述截断）"
                },
                "text": {
                  "type": "string",
                  "description": "Text content when type is text."
                },
                "type": {
                  "type": "string",
                  "description": "Input item type: text, image, local_image, audio, local_audio, skill, or mention."
                }
              },
              "additionalProperties": false
            }
          },
          "message": {
            "type": "string",
            "description": "Initial plain-text task for the new agent. Use either message or items."
          },
          "model": {
            "type": "string",
            "description": "Model override for the new agent. Omit unless an explicit override is needed."
          },
          "reasoning_effort": {
            "type": "string",
            "description": "Reasoning effort override for the new agent. Omit to inherit the parent effort."
          }
        },
        "additionalProperties": false
      }
    },
    {
      "type": "function",
      "name": "multi_agent_v1__wait_agent",
      "description": "Wait for agents to reach a final status. Completed statuses may include the agent's final message. Returns empty status when timed out. Once the agent reaches a…（描述截断）",
      "strict": false,
      "parameters": {
        "type": "object",
        "properties": {
          "targets": {
            "type": "array",
            "description": "Agent ids to wait on. Pass multiple ids to wait for whichever finishes first.",
            "items": {
              "type": "string"
            }
          },
          "timeout_ms": {
            "type": "number",
            "description": "Timeout in milliseconds. Defaults to 30000, min 10000, max 3600000. Prefer longer waits (minutes) to avoid busy polling."
          }
        },
        "required": [
          "targets"
        ],
        "additionalProperties": false
      }
    }
  ],
  "tool_choice": "auto"
}
```
