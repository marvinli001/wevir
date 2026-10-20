-- 0013_workspace_folders：项目的其他源文件夹（协议 0.63.0）。
--
-- extra_folders 是 string[] 的 JSON（各自的 realpath，按添加顺序），不含 root_path；NULL 表示只有 root_path（这一列之前的项目都是）。
-- 项目里新建的会话把它们作为额外的可写目录交给引擎，已经开着的会话不跟着改。
ALTER TABLE workspaces ADD COLUMN extra_folders TEXT;
