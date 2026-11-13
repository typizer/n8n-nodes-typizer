# n8n-nodes-typizer

[Русский](#русский) · [English](#english)

## Русский

Узлы n8n для [Typizer](https://typizer.ru) (интерфейс узлов — на английском, как требует каталог
n8n; типы документов подписаны и по-русски, ошибки — на двух языках): счёт, УПД, акт, ТОРГ-12, договор, выписка или любой
другой документ — PDF, скан или фото — превращается в поля, которые следующий узел (Google Таблицы,
Битрикс24, 1С через HTTP Request, Telegram) берёт напрямую. Обработка и хранение — в России (152-ФЗ).

- **Typizer** — Document → Extract Data (извлечь данные из документа), Run → Get Result (результат прогона), Typizer → Get Many (список типизаторов).
- **Typizer Trigger** — запускает сценарий, когда документ обработан: из n8n, из кабинета
  my.typizer.ru, по API или в пакете.
- **Typizer API** — учётные данные (ключ API).

### Установка

n8n на своём сервере: **Settings → Community Nodes → Install**, имя пакета `n8n-nodes-typizer`.
Если у n8n нет доступа к npm — ручная установка по инструкции n8n «Install community nodes
manually». Пакет собран и проверен с n8n 2.x.

### Подключение

1. В кабинете [my.typizer.ru](https://my.typizer.ru/developers/keys) создайте ключ API. Хватит
   доступа «Только запуск прогонов»; для режима Describe in Words нужен «Полный доступ».
2. В n8n: **Credentials → New → Typizer API**, вставьте ключ. n8n сразу проверит его.

### Typizer: извлечь данные из документа (Document → Extract Data)

На вход — элемент с файлом в бинарном поле (**Input Binary Field**, обычно `data`): вложение письма, файл из Telegram,
Google Диска или HTTP Request. Дальше выберите **Document Type** — что за документ:

| Вариант | Когда |
| --- | --- |
| Ready-Made Document Type | Счёт на оплату, УПД, счёт-фактура, акт, ТОРГ-12, ТТН, договор, платёжное поручение, банковская выписка, кассовый чек, доверенность, смета — поля и проверки (ИНН, КПП, БИК, расчётный счёт, сумма строк) уже подобраны. |
| My Typizer | Типизатор из кабинета: выбор из списка, по ссылке или по ID. Ваши поля, ваши проверки. |
| Describe in Words | «Номер и дата счёта, поставщик с ИНН, итого» — поля составляются один раз и запоминаются активным сценарием, чтобы колонки не менялись. |

По умолчанию узел **ждёт результата** (Wait for Result) (обычно до минуты; несколько документов отправляются сразу и
ждутся вместе) и возвращает поля документа на верхнем уровне элемента:

```json
{
  "number": "418",
  "date": "2026-09-14",
  "supplier": { "name": "ООО «Северный ветер»", "inn": "0012345673", "kpp": "001201001" },
  "items": [{ "name": "Картридж", "quantity": 4, "price": 3200, "amount": 12800 }],
  "total": 16900,
  "_typizer": {
    "run_id": "run_…",
    "status": "succeeded",
    "checks": { "all_ok": false, "warnings": [{ "field": "supplier.inn", "reason": "checksum_mismatch" }], "missing": [] },
    "metadata": { "deal_id": "42" },
    "cabinet_url": "https://my.typizer.ru/runs/run_…"
  }
}
```

- **Split Line Items** (позиции — отдельными элементами): каждая строка таблицы документа становится отдельным
  элементом — например, строкой Google Таблицы. Поле `items` в таком элементе — одна позиция
  (`items.name`, `items.amount`), номер, дата и стороны документа повторяются.
- **Options → Flatten Fields** (плоские поля для таблиц): `supplier.inn` → `supplier_inn` — колонки, которые
  Google Таблицы и Excel сопоставляют автоматически.
- **Options → Run Metadata** (метки прогона): ваши пары ключ — значение (ID сделки, номер письма) — возвращаются в
  `_typizer.metadata` и в Typizer Trigger.
- **Options → Mode: Precise** (точный режим) перепроверяет извлечение — для плохих сканов и важных сумм.
- `_typizer.checks` — что проверить человеку: поля с предупреждением (`warn`) и ненайденные
  (`missing`); `cabinet_url` открывает документ с подсветкой, откуда взято каждое значение.

Выключите Wait for Result, чтобы сразу получить номер прогона, а результат ловить узлом
Typizer Trigger или забрать позже действием Run → Get Result.

Повтор узла (Retry On Fail) не оплачивает документ дважды: запросы идут с ключом идемпотентности.
Ошибки — на английском и русском, с тем, что делать: «не хватает страниц — пополните баланс», «ключ без нужного
доступа», «файл больше 50 МБ». С включённым **Continue On Fail** неудачный документ становится
элементом с полем `error`, а остальные идут дальше.

### Typizer Trigger

Выберите события — Document Processed, Document Failed, Batch Completed, Balance Low — и активируйте сценарий: узел сам регистрирует свой адрес в Typizer и
удаляет его при деактивации. Каждый запрос проверяется по подписи (Standard Webhooks, допуск
5 минут), повтор одного и того же события отбрасывается. Секрет подписи не сохраняется в
сценарии — он держится только в памяти процесса n8n.

Адрес n8n должен быть **публичным https** (переменная `N8N_WEBHOOK_URL` у n8n, в прежних версиях — `WEBHOOK_URL`). Фильтры: Only Typizer,
Only With Metadata (`deal_id=42`). Вывод — тот же, что у узла Typizer.

### Примеры сценариев

В каталоге `examples/` — готовые сценарии для импорта (**Import from File**):

- `invoices-to-google-sheets.json` — счёт из Telegram или письма → Typizer → строка на каждую
  позицию в Google Таблице;
- `bitrix24-deal-invoice.json` — счёт в файловом поле сделки Битрикс24 → Typizer → номер, дата,
  ИНН поставщика и сумма в полях сделки + комментарий в ленте;
- `results-via-trigger.json` — документы из кабинета → Typizer Trigger → сообщение в Telegram.

Документация: [docs.typizer.ru/how-to/n8n](https://docs.typizer.ru/how-to/n8n). Вопросы:
support@typizer.ru.

## English

n8n nodes for [Typizer](https://typizer.ru): an invoice, UPD, act, TORG-12, contract, bank
statement or any other document — PDF, scan or photo — becomes fields the next node (Google
Sheets, Bitrix24, 1C over HTTP Request, Telegram) maps directly. Processing and storage in Russia.

- **Typizer** — Extract data from a document, Get a run result, Get many typizers.
- **Typizer Trigger** — starts a workflow when a document is processed (from n8n, the cabinet,
  the API or a batch).
- **Typizer API** — credentials (API key, tested against `GET /v1/me`).

**Install:** Settings → Community Nodes → Install → `n8n-nodes-typizer` (self-hosted n8n).

**Credentials:** create an API key at my.typizer.ru → API keys ("Runs only" access is enough;
"Describe in Words" needs "Full access").

**Extract:** pass a file in a binary field (usually `data`) and choose the document type — a
ready-made type (invoice, UPD, act…), your typizer from the cabinet (list, URL or ID), or a
description in words. The node waits for the result and returns the document's fields at the top
level of the item, with run meta under `_typizer` (`run_id`, `checks` with warnings and missing
fields, `metadata`, `cabinet_url`). Options: split line items into separate items, flatten nested
fields (`supplier_inn`) for spreadsheets, run metadata, precise mode, max wait. Retries are
idempotent; errors explain what to do.

**Trigger:** registers its webhook in Typizer on activation and removes it on deactivation;
verifies every delivery's signature (Standard Webhooks, 5-minute tolerance), drops replays, keeps
the signing secret in memory only. n8n must have a public https URL.

**Examples:** `examples/` — email/Telegram → Typizer → Google Sheets; Bitrix24 deal file →
Typizer → deal fields; Typizer Trigger → Telegram.

The node interface is in English; ready-made document types also carry their Russian names, and
error messages come in English and Russian. License: MIT.
