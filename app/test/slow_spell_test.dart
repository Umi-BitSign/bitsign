import 'package:bitsign/vision/slow_spell.dart';
import 'package:bitsign/vision/translation.dart';
import 'package:flutter_test/flutter_test.dart';

/// Builds a word that has had [letters] stills taken and is waiting for the next.
SlowSpellWord waitingWith(int letters) {
  var word = SlowSpellWord.idle.start();
  for (var i = 0; i < letters; i++) {
    word = word.takingLetter().letterTaken();
  }
  return word;
}

void main() {
  test('starting a word captures nothing', () {
    final word = SlowSpellWord.idle.start();
    expect(word.inProgress, isTrue);
    expect(word.captured, 0);
    expect(word.letters, isEmpty);
    expect(word.canCapture, isTrue);
  });

  test('one click is one letter, and the count follows the stills', () {
    final word = waitingWith(3);
    expect(word.captured, 3);
    expect(word.stage, SlowSpellStage.waiting);
  });

  test('a word cannot be read until there are two letters to read', () {
    expect(waitingWith(0).canSubmit, isFalse);
    expect(waitingWith(1).canSubmit, isFalse);
    expect(waitingWith(slowSpellMinLetters).canSubmit, isTrue);
  });

  test('a word stops accepting letters at the ceiling', () {
    final full = waitingWith(slowSpellMaxLetters);
    expect(full.isFull, isTrue);
    expect(full.canCapture, isFalse);
    expect(full.canSubmit, isTrue);
  });

  test('capturing and reading are not states that accept a new letter', () {
    expect(waitingWith(2).takingLetter().canCapture, isFalse);
    expect(waitingWith(2).submitting().canCapture, isFalse);
    expect(waitingWith(2).submitting().canSubmit, isFalse);
  });

  test('abandoning a word leaves nothing in progress', () {
    expect(SlowSpellWord.idle.inProgress, isFalse);
    expect(SlowSpellWord.idle.canCapture, isFalse);
    expect(SlowSpellWord.idle.captured, 0);
  });

  test('a read word is no longer in progress but keeps its letters', () {
    final word = waitingWith(5).submitting().read(const ['k', 'e', 'l', 'l', 'y']);
    expect(word.inProgress, isFalse);
    expect(word.word, 'kelly');
  });

  group('the progress panel', () {
    test('fits two lines of twenty-two characters in every state', () {
      for (var captured = 0; captured <= slowSpellMaxLetters; captured++) {
        for (final stage in SlowSpellStage.values) {
          final panel = slowSpellPanel(SlowSpellWord(stage: stage, captured: captured));
          final lines = panel.split('\n');
          expect(lines.length, lessThanOrEqualTo(2), reason: '$stage $captured');
          for (final line in lines) {
            expect(line.length, lessThanOrEqualTo(glassesLineChars), reason: '$stage $captured: $line');
          }
        }
      }
    });

    test('marks every letter taken so far and the position being asked for', () {
      expect(slowSpellPanel(waitingWith(0)), '_\nletter 1  click');
      expect(slowSpellPanel(waitingWith(3)), '***_\nletter 4  click');
    });

    test('says which letter to hold while the still is being taken', () {
      expect(slowSpellPanel(waitingWith(3).takingLetter()), '***?\nhold letter 4');
    });

    test('stops asking for letters once the word is full', () {
      final panel = slowSpellPanel(waitingWith(slowSpellMaxLetters));
      expect(panel, contains('double'));
      expect(panel, isNot(contains('_')));
    });

    test('an idle word blanks the panel rather than leaving the last one up', () {
      expect(slowSpellPanel(SlowSpellWord.idle), isEmpty);
    });

    test('no accuracy figure is ever put in front of the wearer', () {
      for (var captured = 0; captured <= slowSpellMaxLetters; captured++) {
        for (final stage in SlowSpellStage.values) {
          final panel = slowSpellPanel(SlowSpellWord(stage: stage, captured: captured));
          expect(panel, isNot(contains('%')));
          expect(panel, isNot(contains('40.5')));
        }
      }
    });
  });

  group('fixing one letter', () {
    final read = SlowSpellWord.idle.read(const ['k', 'e', 'l', 'l', 'y']);

    test('changes that letter and leaves the rest of the word alone', () {
      expect(read.withLetter(0, 'b').word, 'belly');
      expect(read.withLetter(4, 'e').word, 'kelle');
    });

    test('does not disturb a double letter when the fix is elsewhere', () {
      expect(read.withLetter(1, 'i').word, 'killy');
    });

    test('can fix one half of a double letter', () {
      expect(read.withLetter(3, 'y').word, 'kelyy');
    });

    test('takes an uppercase correction in the label set it has', () {
      expect(read.withLetter(0, 'B').word, 'belly');
      expect(read.withLetter(0, ' b ').word, 'belly');
    });

    test('refuses anything that is not one letter, rather than guessing', () {
      expect(read.withLetter(0, '').word, 'kelly');
      expect(read.withLetter(0, 'bb').word, 'kelly');
      expect(read.withLetter(-1, 'b').word, 'kelly');
      expect(read.withLetter(5, 'b').word, 'kelly');
    });

    test('removes a letter the signer never offered', () {
      final spaced = SlowSpellWord.idle.read(const ['a', ' ', 'b']);
      expect(spaced.withoutLetter(1).word, 'ab');
      expect(spaced.withoutLetter(9).word, 'a b');
    });

    test('the label set a correction offers is what the head can read', () {
      expect(spellableLetters, contains('a'));
      expect(spellableLetters, contains('z'));
      expect(spellableLetters, contains('0'));
      expect(spellableLetters.length, 36);
      expect(spellableLetters, isNot(contains(' ')));
    });
  });
}
