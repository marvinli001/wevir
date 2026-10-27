// 等回答的提问：每个问题一组选项（单选或多选），允许自己填写时多一行输入；都答了才能提交。已在别处回答或取消时显示一行说明。

import type { QuestionAnswer, QuestionRequest } from '@wevir/protocol';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { type MessageKey, t } from '../i18n';
import { answerErrorKey, questionAnswers, questionsComplete } from '../lib/session-actions';
import { RADIUS, TEXT, useTheme } from '../theme';
import { Button, Icon } from './ui';

export function QuestionCard({
  request,
  canAnswer,
  onAnswer,
}: {
  request: QuestionRequest;
  canAnswer: boolean;
  onAnswer: (answers: Record<string, QuestionAnswer>) => Promise<void>;
}) {
  const theme = useTheme();
  const [picked, setPicked] = useState<Record<string, readonly string[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey>();
  const answers = questionAnswers(request, picked, typed);
  const ready = canAnswer && !busy && questionsComplete(request, answers);

  const toggle = (questionId: string, label: string, multi: boolean) => {
    void Haptics.selectionAsync().catch(() => {});
    setPicked((current) => {
      const now = current[questionId] ?? [];
      const next = multi
        ? now.includes(label)
          ? now.filter((l) => l !== label)
          : [...now, label]
        : now.includes(label)
          ? []
          : [label];
      return { ...current, [questionId]: next };
    });
    // 单选题点了选项就不用填的。
    if (!multi) setTyped((current) => ({ ...current, [questionId]: '' }));
  };

  const submit = () => {
    if (!ready) return;
    setBusy(true);
    setError(undefined);
    onAnswer(answers)
      .catch((e: unknown) => setError(answerErrorKey(e)))
      .finally(() => setBusy(false));
  };

  return (
    <View
      style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}
      testID="question-card"
    >
      <View style={styles.head}>
        <Icon
          name={{ ios: 'questionmark.bubble', android: 'contact_support' }}
          size={16}
          color={theme.warning}
        />
        <Text style={[styles.label, { color: theme.warning }]}>{t('session.awaitingInput')}</Text>
      </View>
      {request.questions.map((question) => {
        const chosen = picked[question.id] ?? [];
        const multi = question.multiSelect === true;
        return (
          <View key={question.id} style={styles.question}>
            {question.header !== undefined && question.header !== '' && (
              <Text style={[styles.header, { color: theme.mutedForeground }]}>
                {question.header}
              </Text>
            )}
            <Text style={[styles.text, { color: theme.foreground }]} selectable>
              {question.question}
            </Text>
            {question.options.length > 0 && (
              <View style={styles.options}>
                {question.options.map((option) => {
                  const on = chosen.includes(option.label);
                  return (
                    <Pressable
                      key={option.label}
                      accessibilityRole={multi ? 'checkbox' : 'radio'}
                      accessibilityState={{ checked: on, disabled: !canAnswer }}
                      disabled={!canAnswer || busy}
                      onPress={() => toggle(question.id, option.label, multi)}
                      style={({ pressed }) => [
                        styles.option,
                        {
                          backgroundColor: on ? theme.primary : theme.muted,
                          opacity: pressed ? 0.7 : 1,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.optionLabel,
                          { color: on ? theme.primaryForeground : theme.foreground },
                        ]}
                      >
                        {option.label}
                      </Text>
                      {option.description !== undefined && option.description !== '' && (
                        <Text
                          style={[
                            styles.optionDescription,
                            { color: on ? theme.primaryForeground : theme.mutedForeground },
                          ]}
                        >
                          {option.description}
                        </Text>
                      )}
                    </Pressable>
                  );
                })}
              </View>
            )}
            {(question.allowOther === true || question.options.length === 0) && (
              <TextInput
                value={typed[question.id] ?? ''}
                onChangeText={(value) => {
                  setTyped((current) => ({ ...current, [question.id]: value }));
                  if (!multi && value.trim() !== '')
                    setPicked((current) => ({ ...current, [question.id]: [] }));
                }}
                editable={canAnswer && !busy}
                placeholder={t('question.other')}
                placeholderTextColor={theme.mutedForeground}
                secureTextEntry={question.secret === true}
                selectionColor={theme.foreground}
                style={[styles.input, { color: theme.foreground, backgroundColor: theme.muted }]}
              />
            )}
          </View>
        );
      })}
      {error !== undefined && (
        <Text style={[styles.note, { color: theme.destructive }]}>{t(error)}</Text>
      )}
      {canAnswer ? (
        <Button title={t('question.submit')} disabled={!ready} onPress={submit} />
      ) : (
        <Text style={[styles.note, { color: theme.mutedForeground }]}>
          {t('thread.answerOnComputer')}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 20,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    gap: 14,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  label: { fontSize: TEXT.small, fontWeight: '600' },
  question: { gap: 10 },
  header: { fontSize: TEXT.caption, fontWeight: '600' },
  text: { fontSize: TEXT.body, lineHeight: 22 },
  options: { gap: 8 },
  option: {
    borderRadius: RADIUS.control,
    borderCurve: 'continuous',
    paddingHorizontal: 14,
    paddingVertical: 11,
    gap: 2,
  },
  optionLabel: { fontSize: 15, fontWeight: '500' },
  optionDescription: { fontSize: TEXT.small, lineHeight: 19 },
  input: {
    fontSize: 15,
    borderRadius: RADIUS.control,
    borderCurve: 'continuous',
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  note: { fontSize: TEXT.small },
});
