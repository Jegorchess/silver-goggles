# KinoBattleApp — кіно-квіз батл для iOS (у розробці)

Дуель 1 на 1 проти бота: 7 або 14 питань про кіно (і його історію), 10 секунд на кожне, 4 варіанти,
більше очок за швидку відповідь, фінальне питання ×2.

Рішення для MVP (відрізняються від початкової специфікації):
- без категорій і без складності питань — одразу старт раунду;
- без паузи: якщо згорнути застосунок, таймер іде далі;
- без підтримки VoiceOver.

## Що вже є

`KinoBattleApp/Engine/` — ігрова логіка без залежності від UI:
- `Question.swift` — формат питання з `questions.json` і перемішування варіантів;
- `QuestionBank.swift` — валідація бази та вибірка 7 питань без повторів з недавніх матчів;
- `Scoring.swift` — правила матчу, формула очок `round(500 + 500·t/10) × k`, визначення переможця;
- `Opponent.swift` — протокол `Opponent` (під майбутній онлайн), `BotOpponent` і детермінований генератор для тестів.

## Далі

- `MatchEngine` — перебіг матчу й таймер на монотонному годиннику;
- екрани: головний, матч, результат (реванш одним тапом);
- `questions.json` зі стартовим набором питань;
- проєкт Xcode (рушій підключається як локальний пакет).

## Збірка й тести рушія

Рушій оформлено як Swift-пакет `KinoBattleEngine` (`Package.swift`), тести — у `Tests/KinoBattleEngineTests/`.

На Mac: `swift test` або відкрити `Package.swift` у Xcode.

На Windows/Linux через Docker (Swift ставити не треба):

```sh
docker run --rm -v "${PWD}:/src" -w /src swift:6.0 swift test --scratch-path /tmp/build
```

Сам iOS-застосунок збирається й запускається лише на Mac з Xcode.

## Превʼю на Windows (у VS Code)

`preview/index.html` — інтерактивний макет гри в рамці iPhone. Логіка — порт `Engine/` на JS,
питання — з того самого `KinoBattleApp/questions.json`. Якщо змінюєш правила у Swift, онови й превʼю.

1. `Ctrl+Shift+P` → **Tasks: Run Task** → **Preview: запустити сервер** (або `python -m http.server 5180`).
2. `Ctrl+Shift+P` → **Simple Browser: Show** → `http://localhost:5180/preview/`.
