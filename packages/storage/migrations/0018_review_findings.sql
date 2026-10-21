-- 0018_review_findings：agent 报出的审查发现也存成批注（协议 0.83.0 的 review.findings）。
--
-- finding 是发现的标题、严重度、把握与提出它的回合（ReviewFindingFields 的 JSON）；NULL 是用户写的批注。
ALTER TABLE review_comments ADD COLUMN finding TEXT;
