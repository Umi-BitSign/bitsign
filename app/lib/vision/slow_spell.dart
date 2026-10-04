import 'translation.dart';

/// Slow-spell: the phone asks for one letter at a time and captures one still
/// for each.
///
/// The camera is configured at 1 fps and fluent fingerspelling runs at four to
/// six letters a second, so a continuous burst never observes most of the
/// letters rather than merely truncating them, and greedy CTC cannot emit more
/// labels than the encoder has timesteps, which is one per still. Asking for
/// the letters one at a time is not natural signing and nothing here pretends
/// it is; it is an honest exchange that works on stock firmware today.
///
/// The turn-taking is built on the gestures frame_app.lua already binds.
/// Single click takes the letter the signer is holding, double click ends the
/// word and reads it, long press abandons it. Starting a word is a double click
/// too, so single click keeps its existing meaning when no word is in progress.
enum SlowSpellStage { idle, waiting, capturing, reading }

/// What the head can read, and so what a correction may choose from. It mirrors
/// the label set in services/vision/spell_runner.py, less the space label,
/// which a correction removes rather than selects.
const spellableLetters = 'abcdefghijklmnopqrstuvwxyz0123456789';

const slowSpellStart = 'Ask for the first letter. Click once for each letter, double click when the word is done, long press to abandon it.';
const slowSpellTooShort = 'A word needs at least two letters before it can be read.';
const slowSpellFull = 'That is as long a word as one turn can carry. Double click to read it.';
const slowSpellReading = 'Reading the letters…';
const slowSpellCancelled = 'Word abandoned. Nothing was kept.';

/// One slow-spell word as the phone and the glasses see it. The stills
/// themselves are held by the caller and never by this class.
class SlowSpellWord {
  final SlowSpellStage stage;

  /// How many stills have been taken, which is how many letters were asked for.
  final int captured;

  /// What came back, one entry per still. Empty until the word has been read.
  final List<String> letters;

  const SlowSpellWord({
    this.stage = SlowSpellStage.idle,
    this.captured = 0,
    this.letters = const [],
  });

  static const idle = SlowSpellWord();

  bool get inProgress => stage != SlowSpellStage.idle;

  bool get canCapture => stage == SlowSpellStage.waiting && captured < slowSpellMaxLetters;

  bool get canSubmit => stage == SlowSpellStage.waiting && captured >= slowSpellMinLetters;

  bool get isFull => captured >= slowSpellMaxLetters;

  /// The word as it currently reads, including any correction.
  String get word => letters.join();

  /// Double click with no word in progress. Starting one captures nothing.
  SlowSpellWord start() => const SlowSpellWord(stage: SlowSpellStage.waiting);

  /// Single click: the signer is holding a letter, so take one still for it.
  SlowSpellWord takingLetter() => SlowSpellWord(stage: SlowSpellStage.capturing, captured: captured);

  /// The still arrived, so that position is filled and the next one is asked for.
  SlowSpellWord letterTaken() => SlowSpellWord(stage: SlowSpellStage.waiting, captured: captured + 1);

  /// Double click: no more letters, read what was captured.
  SlowSpellWord submitting() => SlowSpellWord(stage: SlowSpellStage.reading, captured: captured);

  /// The reading came back. The word is no longer in progress, and the letters
  /// stay behind for the wearer to correct.
  SlowSpellWord read(List<String> spelled) =>
      SlowSpellWord(letters: List.unmodifiable(spelled));

  /// Replaces one letter without spelling the word again. A single still cannot
  /// be re-read on its own, because the preprocessing needs two frames, so a
  /// correction is made here rather than by capturing that letter again.
  SlowSpellWord withLetter(int index, String letter) {
    final fixed = letter.trim().toLowerCase();
    if (index < 0 || index >= letters.length || fixed.length != 1) return this;
    final next = List<String>.of(letters);
    next[index] = fixed;
    return SlowSpellWord(stage: stage, captured: captured, letters: List.unmodifiable(next));
  }

  /// Drops one letter. The head can read a held hand as the space label, which
  /// is a letter the signer never offered.
  SlowSpellWord withoutLetter(int index) {
    if (index < 0 || index >= letters.length) return this;
    final next = List<String>.of(letters)..removeAt(index);
    return SlowSpellWord(stage: stage, captured: captured, letters: List.unmodifiable(next));
  }
}

/// What the wearer sees while the word is being built.
///
/// Two lines of 22 characters. frame_app.lua clears the panel before each
/// redraw because the display has no double buffer, so a shorter panel cannot
/// leave the tail of a longer one behind.
///
/// The marks are positions, not letters: reading a single still costs a whole
/// model load, so the letters are not known until the word is submitted and
/// the panel does not invent them. The position being asked for next is the
/// underscore at the end.
String slowSpellPanel(SlowSpellWord word) {
  final marks = '*' * word.captured;
  switch (word.stage) {
    case SlowSpellStage.idle:
      return '';
    case SlowSpellStage.waiting:
      if (word.isFull) return '$marks\nfull - double to read';
      return '${marks}_\nletter ${word.captured + 1}  click';
    case SlowSpellStage.capturing:
      return '$marks?\nhold letter ${word.captured + 1}';
    case SlowSpellStage.reading:
      return '$marks\nreading';
  }
}
