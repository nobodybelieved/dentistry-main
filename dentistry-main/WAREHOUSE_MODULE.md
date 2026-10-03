# WMS-модуль Pllato CRM — техническая спецификация для воспроизведения

> Документ для разработчика / AI-агента, которому поручили реализовать
> аналогичный складской модуль в другой CRM-системе. Содержит модель данных,
> ключевые алгоритмы, файловую структуру, печатные формы, интеграции и
> известные ловушки. Источник истины — `app/warehouse.js`, `app/stocktake.js`,
> `app/deal_items.js`, `app/wh_*.js`, `app/views/warehouse/*` в репозитории
> `pllato/pllato-core-crm`.

---

## 0. Контекст

WMS-модуль работает в составе CRM для медицинского дистрибьютора (Aminamed).
Объёмы:

- ~200–300 SKU
- ~5–10 партий на SKU (LOT, серии, срок годности)
- 10–30 тысяч движений в год (приход + расход)
- 5–15 пользователей (менеджеры, кладовщик, директор, бухгалтер, полевые)
- 5 юр.лиц-отправителей (ТОО, 5 разных компаний под одним брендом)
- Двухуровневая иерархия складских мест: «по юрлицу» (ТОО/ИП)

Ключевые требования:

1. **Партионный учёт** с FIFO/FEFO-списанием.
2. **Двусторонний документооборот** CRM ↔ 1С Бухгалтерия (отдельный модуль-коннектор, не входит в WMS как таковой).
3. **Печатные формы РК** — З-2 (расходная накладная Приложение 26 МФ РК) и ИНВ-3 (сличительная ведомость Приложение 25 МФ РК).
4. **Инвентаризация** с двухступенчатым согласованием (кладовщик → директор) и автокорректировкой остатков.
5. **Канбан заказов** (preliminary → approved → shipped) с авто-промоцией и идемпотентным созданием накладных.
6. **Импорт большой Книги учёта** (Excel) — десятки тысяч движений за разовый импорт.
7. **Соответствие законодательству РК** с 01.01.2026 — поля НКТ, GTIN, КТ-ТНВЭД, КТТ в номенклатуре и ЭСФ.

---

## 1. Архитектура и стек

| Слой | Технология | Зачем |
|---|---|---|
| Frontend | Vanilla HTML/CSS/JS, ES modules, без сборки | Простой деплой, легко поддерживать |
| Storage | localStorage + IndexedDB + Cloudflare D1 | См. §10 — стратегия трёхуровневая |
| Backend | Cloudflare Workers (REST endpoints) | Для cloud sync и tenant isolation |
| Print | `window.open()` + inline HTML + `window.print()` | Без серверных шаблонизаторов |
| Сторонние библиотеки | SheetJS (xlsx) | Только для импорта Excel |

**Без зависимостей** от React/Vue/jQuery/Webpack — всё на чистом JS, ES modules
загружаются прямо в браузер. Это критично для быстрого деплоя на Cloudflare Pages
и для отсутствия build-step'а.

---

## 2. Модель данных

Каждая коллекция — массив JSON-объектов в одном из 3 storage-слоёв (см. §10).
Имена коллекций объявлены в `app/warehouse.js`:

```js
export const WH = {
  products: "warehouse_products",      // карточки товаров (SKU)
  lots: "warehouse_lots",              // партии (LOT/серия/срок годности)
  movements: "warehouse_movements",    // движения (приход/расход) — в IndexedDB!
  documents: "warehouse_documents",    // документы (накладные, акты)
};
```

### 2.1 `warehouse_products` — карточка товара

```js
{
  id: "wp_xxx",                    // ID (auto)
  sku: "T0000000211",              // артикул (уникален в рамках entity)
  name: "Одноразовые лезвия...",   // название
  entity: "ТОО" | "ИП",            // юр.лицо владелец товара
  category: "Хирургия",            // категория
  unit: "шт" | "уп" | "мл",        // единица измерения
  price: 1500,                     // цена продажи (₸)
  cost: 1200,                      // себестоимость (₸)
  // КЗ-специфика (с 01.01.2026):
  nkt: "...",                      // код НКТ (Национальный каталог товаров)
  gtin: "...",                     // GTIN временный
  intin: "...",                    // Intin (после регистрации) — заменяет GTIN
  tnved: "9018...",                // КТ-ТНВЭД
  ktt: "...",                      // КТТ
  // Документы:
  certificateFileUrl: "...",       // ссылка на сертификат
  registrationDocUrl: "...",       // регистрационное удостоверение
  // Доп:
  archived: false,                 // soft-delete
  customerName: "Лезвия 10мм",     // для двойного наименования в накладной
  createdAt: 1779862...,
  updatedAt: 1779862...,
}
```

**Дедуп ключ**: `(sku, entity)` — у одного SKU могут быть разные карточки для ИП и ТОО (раздельные остатки).

### 2.2 `warehouse_lots` — партия

```js
{
  id: "wl_xxx",
  productId: "wp_xxx",             // FK → warehouse_products.id
  lotCode: "RC-2025-001-1",        // серия партии (часто = номер прихода + порядковый)
  inDate: "2025-08-15",            // дата прихода (для FIFO)
  expiryDate: "2027-08-15",        // срок годности (для FEFO)
  expiryRaw: "08.2027",            // как пришло из импорта (для display)
  initialQty: 100,                 // изначально принято
  currentQty: 73,                  // остаток текущий (уменьшается при расходе)
  supplierDocId: "wd_xxx",         // FK → warehouse_documents.id (приход который её создал)
  supplierContactId: "c_xxx",      // FK → contacts.id (поставщик)
  note: "",
}
```

**Инвариант**: `currentQty >= 0`. Не должно быть отрицательным.
`currentQty` — единственная мутабельная вещь в lot после создания.

### 2.3 `warehouse_movements` — движение (приход/расход)

```js
{
  id: "wm_xxx",
  productId: "wp_xxx",             // FK
  lotId: "wl_xxx",                 // FK
  lineRef: "li_xxx",               // строка документа (для traceability)
  date: "2026-05-27",              // дата операции (ISO)
  qty: 5,                          // количество (всегда положительное)
  direction: "in" | "out",         // приход/расход
  type: "receipt" | "sale" | "writeoff" | "damage" | "return_in" | "return_out" | "transfer" | "stocktake",
  docId: "wd_xxx",                 // FK → документ
  counterpartyContactId: "c_xxx",  // FK → клиент
  counterpartyText: "ТОО Аптека",  // fallback если контакта нет
  dealId: "d_xxx",                 // FK → сделка (опционально)
  note: "",
  balanceAfter: 68,                // остаток партии после операции (для аудита)
  createdBy: "u_xxx",              // FK → employee
  createdAt: 1779862...,           // timestamp ms
  splitFromLineId: null,           // если строка разбита FIFO — ссылка на родительскую
}
```

**Хранятся в IndexedDB** через `app/wh_movements_db.js` (см. §10). 28 тысяч записей
после импорта Книги учёта — в localStorage не помещаются (10 МБ Chrome limit).

### 2.4 `warehouse_documents` — документ

```js
{
  id: "wd_xxx",
  type: "receipt" | "sale_invoice" | "sale_act" | "writeoff_act" | "damage_act" | "return_in" | "return_out" | "transfer",
  number: "SALE_INVOICE-2026",     // автогенерированный или вручную (см. nextDocNumber)
  date: "2026-05-27",
  status: "draft" | "posted" | "cancelled",
  // Контрагент:
  counterpartyContactId: "c_xxx",  // FK или null
  counterpartyText: "ТОО Аптека · Заказ от pllato",
  dealId: "d_xxx",                 // если документ из сделки CRM
  // Позиции:
  items: [                         // нормализованные позиции (см. normalizeDocItems)
    {
      lineId: "li_xxx",
      productId: "wp_xxx",
      productSku: "T...",
      productName: "...",
      qty: 5,
      unitPrice: 1500,
      lineAmount: 7500,
      lotId: "wl_xxx",             // только для расходных (после FIFO-split)
      lotCode: "...",
      expiryDate: "2027-08-15",
      splitFromLineId: null,       // если строка разбита по партиям
    },
  ],
  totalAmount: 12500,
  currency: "KZT",
  note: "",
  postedAt: 1779862...,            // когда проведён
  cancelledAt: null,
  attachedFiles: [],
  // Поля специфичные для типа:
  // receipt: gtdNumber, edvsNumber — для импортных
  createdBy: "u_xxx",
  createdAt: 1779862...,
}
```

**Статусы документа** (state machine):

```
draft  ──post──▶  posted  ──cancel──▶  cancelled
  │                  │
  │                  └─ единственный путь правки = отмена + создание нового
  │
  └──delete──▶ удалён (только из draft)
```

### 2.5 `deal_items` — позиции заказа в сделке CRM

См. `app/deal_items.js`. Заказ сначала формируется в CRM (deal), потом отгружается со склада.

```js
{
  id: "di_xxx",
  dealId: "d_xxx",
  productId: "wp_xxx",
  productSku: "...",
  productName: "...",
  unit: "шт",
  qty: 5,
  unitPrice: 1500,
  lineAmount: 7500,
}
```

**Поле в сделке `deal.orderStatus`**:

```
draft (без позиций или невалидных)
  ↓ авто-промоция при первой валидной позиции
preliminary (на складе видна в "Предварительных")
  ↓ approveDealOrder()
approved (директор согласовал, склад собирает)
  ↓ createInvoiceFromDeal() + markDealOrderShipped()
shipped (накладная сформирована и проведена)
```

Дополнительные поля сделки:
`orderSubmittedAt/By/ByName`, `orderApprovedAt/By/ByName`, `orderShippedAt/By/ByName`,
`orderInvoiceId`, `orderInvoiceNumber`.

### 2.6 `stocktakes` — инвентаризация

См. `app/stocktake.js`.

```js
{
  id: "st_xxx",
  number: "STK-2026-0001",
  date: "2026-05-26",
  status: "draft" | "pending" | "approved" | "rejected" | "cancelled",
  entity: "ТОО" | "ИП" | "",       // юр.лицо (опционально)
  scope: "all" | "category",       // вся номенклатура или категория
  scopeFilter: "Хирургия",         // если scope=category
  items: [                         // снапшот системных остатков + факт
    {
      productId: "wp_xxx",
      sku: "...",
      name: "...",
      expectedQty: 73,             // системный остаток на момент создания
      actualQty: 70,               // фактический (вводится менеджером)
      diff: -3,                    // actualQty - expectedQty
      counted: true,               // ввели факт или нет
      reason: "damage" | "natural" | "expired" | "theft" | "mistake" | "sample" | "other" | "",
    },
  ],
  totals: {                        // computeTotals(items)
    productsTotal: 200,
    productsCounted: 150,
    shortageQty: 25,               // сумма недостач
    shortageAmount: 37500,         // сумма недостач в ₸
    surplusQty: 5,
    surplusAmount: 7500,
  },
  notes: "",
  createdBy, createdByName, createdAt,
  submittedBy, submittedByName, submittedAt,
  approvedBy, approvedByName, approvedAt,
  approvalComment: "",
  rejectionReason: "",
  appliedDocumentIds: ["wd_xxx", "wd_yyy"], // документы списания + прихода
  applyErrors: [],                          // ошибки при автопроводке
}
```

### 2.7 `organizations` — юр.лица для печатных форм

См. `app/organizations.js`.

```js
{
  id: "org_xxx",
  type: "ТОО" | "ИП",
  name: "ТОО Аминамед",
  shortName: "Аминамед",
  bin: "060540006532",            // БИН/ИИН
  iik: "KZ...",                   // расчётный счёт
  bik: "HSBKKZKX",                // БИК
  bank: "АО «Народный банк Казахстана»",
  address: "050060, г. Алматы...",
  phone: "...",
  email: "...",
  directorName: "Алишерова Ф. А.", // для подписи в накладной
  directorPosition: "Генеральный директор",
  molName: "Селенков И. В.",       // МОЛ (для печатных форм)
  accountantName: "...",
  stampUrl: "",                    // картинка печати (опционально)
  signatureUrl: "",
  isDefault: true,
  archived: false,
}
```

---

## 3. Файловая структура

### Бизнес-логика (`app/`)

| Файл | Что внутри | Ключевые экспорты |
|---|---|---|
| `app/warehouse.js` | **Ядро** WMS: товары, партии, документы, движения, FIFO-логика, импорт, отчёты | `WH`, `DOCUMENT_TYPES`, `listWarehouseProducts`, `saveWarehouseProduct`, `createWarehouseDocument`, `postWarehouseDocument`, `cancelWarehouseDocument`, `createInvoiceFromDeal`, `findInvoiceByDeal`, `importWarehouseBatch`, `buildBalancesOnDate`, `productSummary` |
| `app/stocktake.js` | Инвентаризация: модель + автопроводка остатков | `STOCKTAKE_STATUS`, `SHORTAGE_REASONS`, `createStocktake`, `setActualQty`, `submitStocktake`, `approveStocktake`, `rejectStocktake`, `computeTotals` |
| `app/deal_items.js` | Позиции заказа в сделке CRM + статусы заказа + reconciler | `ORDER_STATUS_*`, `listDealItems`, `dealItemsTotal`, `approveDealOrder`, `revokeDealOrderApproval`, `markDealOrderShipped`, `reconcileOrderStatuses` |
| `app/organizations.js` | Справочник юр.лиц для печатных форм | `listOrganizations`, `getDefaultOrganization`, `findOrganizationByEntity`, `saveOrganization` |
| `app/wh_movements_db.js` | IndexedDB-обёртка для movements (обход 10 МБ localStorage) | `putMovement`, `putManyMovements`, `getMovementsByProduct`, `countMovements`, `clearAllMovements` |
| `app/wh_documents_db.js` | IndexedDB-обёртка для documents (10к+ накладных) | `putDocument`, `putManyDocuments`, `getDocumentById`, `getRecentDocuments` |

### UI (`app/views/warehouse/`)

| Файл | Что рендерит | Маршрут |
|---|---|---|
| `index.js` | Главный shell склада с табами + state + router | `#warehouse` |
| `products_list.js` | Список SKU с поиском, фильтрами, пагинацией | `#warehouse/catalog` |
| `product_card.js` | Карточка товара: остатки по партиям, история движений, timeline | `#warehouse/products/:id` |
| `documents_list.js` | Список документов с фильтрами (тип/статус) + пагинация | `#warehouse/documents` |
| `document_form.js` | Создание/редактирование документа | `#warehouse/documents/new` |
| `preliminary_orders.js` | Канбан 3-колонки (Предварительные/Согласованы/Отгружены) | `#warehouse/orders` |
| `stocktake_view.js` | Инвентаризация: список (канбан) + карточка | `#warehouse/stocktakes` |
| `stocktake_print.js` | Печатная сличительная ведомость (ИНВ-3) | вызывается из карточки |
| `invoice_print.js` | Печатная расходная накладная (З-2 Приложение 26) | вызывается из карточки сделки |
| `import_xlsx.js` | Импорт Excel-книги учёта (280 листов, 28к движений) | `#warehouse/import` |
| `reports.js` | Отчёты: KPI, alerts, баланс на дату | `#warehouse/reports` |

---

## 4. Ключевые алгоритмы

### 4.1 FIFO-списание (по дате прихода)

См. `buildPostingPlan` в `app/warehouse.js` (строки ~825-933).

При проведении расходного документа (sale_invoice, writeoff_act и т.д.):

1. `autoSplitDocumentItems(type, items)` — разбивает позицию по партиям, начиная с самой старой.
2. Для каждой партии: проверка остатка, генерация movement и обновление `lots.currentQty -= qty`.
3. Если остатка не хватает — `throw new Error("Недостаточно остатка")`. Документ остаётся в draft.

```js
function sortLotsFifo(a, b) {
  const byInDate = compareDateAsc(a.inDate, b.inDate);
  if (byInDate !== 0) return byInDate;
  const byExpiry = compareDateAsc(a.expiryDate, b.expiryDate);
  if (byExpiry !== 0) return byExpiry;
  return String(a.id).localeCompare(String(b.id));
}
```

**Для FEFO** (по сроку годности — медицинский use case) — поменять порядок: сначала
`expiryDate`, потом `inDate`. Из транскрипта встречи: «Это не FIFO. У нас правило,
что всегда списывается по сроку годности».

### 4.2 Атомарное проведение документа

```js
postWarehouseDocument(docId) {
  const doc = getWarehouseDocument(docId);
  if (doc.status !== "draft") throw new Error("Провести можно только черновик");

  const plan = buildPostingPlan(doc);  // вычисляет всё ДО записей

  // Создаём lots
  const createdLotIds = [];
  plan.lotCreates.forEach((lotPayload) => {
    const created = Store.create(WH.lots, lotPayload);
    createdLotIds.push(created.id);
  });

  // Обновляем остатки существующих lots
  plan.lotUpdates.forEach((patch) => {
    Store.update(WH.lots, patch.lotId, { currentQty: patch.currentQty });
  });

  // Создаём movements (с разрешением __new_N → реальных lot id)
  // ...

  // Обновляем документ
  return Store.update(WH.documents, doc.id, {
    status: "posted", postedAt: now, items: rows, totalAmount,
  });
}
```

**Гарантия консистентности**: вся проводка считается синхронно в `buildPostingPlan`,
никаких частичных коммитов. Если упадёт `throw` — документ останется в draft.

### 4.3 Отмена документа (cancelWarehouseDocument)

Симметричная операция:
- Восстанавливает `lots.currentQty` обратно по движениям документа
- Создаёт обратные `movements` с пометкой `cancelled`
- Удаляет partner-lots если они были созданы этим документом и сейчас пусты

### 4.4 Инвентаризация: автокоррекция остатков

См. `approveStocktake` в `app/stocktake.js`.

Когда директор согласовывает инвентаризацию:

1. Группируем `items` по типу: **shortage** (diff < 0) и **surplus** (diff > 0).
2. Для **shortage**: создаём документ `writeoff_act` с FIFO-списанием.
3. Для **surplus**: создаём документ `receipt` с пометкой «Излишки инвентаризации».
4. Записываем в `stocktake.appliedDocumentIds` для отслеживания.
5. Каждое движение получает `type: "stocktake"` (отдельный movement type).

### 4.5 Идемпотентное создание накладной из сделки

```js
createInvoiceFromDeal(dealId, extra) {
  const existing = safeList(WH.documents).find((d) =>
    d.dealId === dealId &&
    d.type === "sale_invoice" &&
    d.status !== "cancelled"
  );
  if (existing) {
    // Если осталась draft — провести сейчас
    if (existing.status === "draft") {
      const posted = postWarehouseDocument(existing.id);
      return { doc: posted, created: false, posted: true };
    }
    return { doc: existing, created: false };
  }
  // Создаём новую + сразу проводим (FIFO-списание со склада)
  const doc = createWarehouseDocument({ ... });
  try {
    const posted = postWarehouseDocument(doc.id);
    return { doc: posted, created: true, posted: true };
  } catch (err) {
    return { doc, created: true, posted: false, postError: err.message };
  }
}
```

**Важно**: после получения `doc` caller **синхронно** вызывает
`markDealOrderShipped(dealId, { invoiceId: doc.id, invoiceNumber: doc.number })`.
Если делать через async — UI рефреш срабатывает раньше, статус заказа не успевает обновиться.

### 4.6 Авто-промоция сделки в Preliminary

```js
function autoPromoteToPreliminary(dealId) {
  const deal = Store.get(DEALS, dealId);
  const status = deal.orderStatus || ORDER_STATUS_DRAFT;
  if (status !== ORDER_STATUS_DRAFT) return;  // только из draft
  const hasValid = listDealItems(dealId).some(
    (i) => i.productId && (Number(i.qty) || 0) > 0
  );
  if (!hasValid) return;
  // Промоция + activity в timeline
  Store.update(DEALS, dealId, {
    orderStatus: ORDER_STATUS_PRELIMINARY,
    orderSubmittedAt: now, ...
  });
}
```

Зовётся из `createDealItem` и `updateDealItem`. Как только в сделке появилась
первая валидная позиция (товар + qty > 0) — заказ автоматически на складе.

### 4.7 Reconciler на старте приложения

См. `reconcileOrderStatuses` в `app/deal_items.js`. Зовётся в `hydrateAfterSignIn` после `Store.cloudBootstrap()`:

1. Для каждой `sale_invoice` (не cancelled) с привязанным `dealId`:
   если deal.orderStatus !== "shipped" → markDealOrderShipped.
2. Для каждого `draft`-заказа с валидными позициями → autoPromoteToPreliminary.

Идемпотентно, исправляет orphan-данные из старых сессий.

---

## 5. Workflow заказа (CRM ↔ Склад)

```
Менеджер в CRM:
  Открывает сделку → модалка позиций → добавляет товары
    ↓ авто-промоция (4.6)
  orderStatus = preliminary
  → видно в Складе → Заказы, колонка "Предварительные"

Директор:
  Согласовывает (из CRM или с канбана склада)
    ↓ approveDealOrder()
  orderStatus = approved
  → колонка "Согласованы на отгрузку"

Кладовщик:
  Кнопка "📦 Отгрузить и сформировать накладную"
    ↓ createInvoiceFromDeal() + auto-post (FIFO-списание)
    ↓ markDealOrderShipped()
  orderStatus = shipped
  → колонка "Отгружены"
  → накладная № SALE_INVOICE-NNNN
  → товар физически списан со склада (lots.currentQty уменьшен)
```

**Канбан 3 колонки** (`preliminary_orders.js`):
- Колонка 1: «Предварительные заказы» — `listPreliminaryDealOrders()`
- Колонка 2: «Согласованы на отгрузку» — `listApprovedDealOrders()`
- Колонка 3: «Отгружены» — `listShippedDealOrders().slice(0, 20)` (последние 20)

В карточке сделки в CRM — action-bar с 3 кнопками + статус-чип в кнопке заказа:

```
[📞 Позвонить] [💬 WhatsApp +5] [📦 Заказ · 12 300 ₸  ⏳ На складе]
                                              ↑ цвет и текст меняются по статусу
```

---

## 6. Печатные формы

Подход: `window.open()` → новое окно с inline HTML → `window.print()`. Без серверной генерации.

### 6.1 Расходная накладная (Форма З-2, Приложение 26 МФ РК 562)

`app/views/warehouse/invoice_print.js`. Экспорт: `printInvoiceZ2(docId)`.

Содержит:
- Шапка «Приложение 26 МФ РК от 20.12.2012 № 562 / Форма З-2»
- Реквизиты организации (из `organizations`, поиск по `entity` сделки)
- Номер и дата документа
- Таблицы: отправитель / получатель / позиции
- Итог прописью: `tengeInWords(amount)` — отдельная утилита внутри файла:
  ```js
  function intToWords(n) { /* 0..999 в текст */ }
  function tripleToWords(n, gender, words) { /* единицы/десятки/сотни */ }
  function tengeInWords(amount) { /* интегрирует всё */ }
  ```
- Подписи: «Финансовый директор», «Главный бухгалтер», «МОЛ» (из organization), «Получил», М.П.

### 6.2 Сличительная ведомость (Форма ИНВ-3, Приложение 25 МФ РК 562)

`app/views/warehouse/stocktake_print.js`. Экспорт: `printStocktakeReport(stocktakeId, opts)`.

`opts.mode`:
- `'full'` — все позиции (полная опись)
- `'differences'` — только расхождения (недостача + излишки)

Содержит:
- Шапка с реквизитами организации (через `findOrganizationByEntity(stocktake.entity)`)
- Таблица: №, Номенкл. №, Наименование, Ед., По учёту, Фактически, Δ кол-во, Δ сумма, Причина
- Подсветка строк: `row-shortage` (красная), `row-surplus` (зелёная), `row-uncounted` (серая)
- Блоки итогов «НЕДОСТАЧА» / «ИЗЛИШКИ»
- Подписи: Председатель (директор), 2 члена комиссии, МОЛ, М.П.

---

## 7. Интеграции

### 7.1 Уведомления в Telegram о новых field-заказах

Когда полевой менеджер создаёт заказ (`source: "Field"` + `orderStatus: "preliminary"`),
worker `pllato-comm` синхронно после сохранения отправляет сообщение в Telegram-группу
со ссылкой на сделку.

См. `notifyFieldDealsToTelegram` в `worker/worker.js`. D1-таблица `field_tg_notifications`
для идемпотентности (одна нотификация на dealId).

Требуются secrets: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_FIELD_CHAT_ID`.

### 7.2 Подмена pipelineId для field-заказов

Pipelines не синхронизируются между клиентами (каждый ensurePipelinesInitialized
делает свои с уникальными id). Worker в `handleStorePush` подменяет `pipelineId` и
`stage` field-заказов на canonical значения из env: `FIELD_PIPELINE_ID`, `FIELD_STAGE_ID`.

### 7.3 1С Бухгалтерия

**НЕ входит в WMS-модуль**. Отдельный «1С-коннектор» как универсальный адаптер.
Состав работ согласовывается с клиентом через `agreements/aminamed-1c.html`.

Ключевые точки интеграции:
- Выгрузка номенклатуры → `warehouse_products`
- Выгрузка партий → `warehouse_lots`
- Выгрузка остатков → обновление `lots.currentQty`
- Двусторонняя синхронизация документов: при `posted` в CRM → создаётся документ реализации в 1С
- ГТД → ЭДВС → источник на ЭСФ построчно (для импорта)

---

## 8. Импорт Excel-книги учёта

См. `app/views/warehouse/import_xlsx.js` + `importWarehouseBatch` в `warehouse.js`.

**Источник**: Excel-файл «Книга учёта ТОО/ИП» — 280 листов (по 1 SKU на лист), ~28 000
строк движений общим объёмом ~15 МБ.

**Парсинг** через [SheetJS (xlsx)](https://cdn.sheetjs.com/) — CDN-загрузка.

**Алгоритм**:

1. Парс через `XLSX.read` → массив листов.
2. На каждом листе: первая строка — заголовок с SKU+названием товара, остальные — движения.
3. Распознавание движения: дата (приход/расход), количество, поставщик/клиент.
4. Дедупликация товаров по `(sku, entity)`.
5. Из движений строим партии: расходы привязываются к последней партии прихода с положительным остатком (FIFO).
6. Запись через `Store` (товары и партии) + IndexedDB (движения и документы) батчами по 500-1000 записей.

**UI**: progress-bar + 3 селекта `movementsTarget` / `documentsTarget` / `entity` с опциями `'indexeddb' | 'localstorage' | 'skip'`.

---

## 9. Печать и UX-детали

### 9.1 Канбан заказов: цвета колонок

| Колонка | Цвет | Иконка |
|---|---|---|
| Предварительные | `#6366f1` (синий) | — |
| Согласованы на отгрузку | `#f59e0b` (оранжевый) | — |
| Отгружены | `#16a34a` (зелёный) | ✅ |

CSS — grid 3 колонки минимум 320px, `min-width: 0` на колонке обязательно.

### 9.2 Карточка заказа

В режиме `preliminary` / `approved` — детальная информация, кнопки действий внутри `<details>`.

В режиме `shipped` — opacity 0.82 + бронзовый левый бордер + кнопка «📄 Открыть накладную».

### 9.3 Action-bar сделки — 3 кнопки

```
[📞 Позвонить] [💬 WhatsApp +N] [📦 Заказ · X ₸  [статус-чип]]
```

Статус-чип внутри кнопки заказа меняет цвет: серый (черновик) → оранжевый (preliminary) → зелёный (approved) → фиолетовый (shipped).

Все действия с заказом (согласование/отзыв/отгрузка/печать) — **внутри** модалки заказа,
не в action-bar (см. `renderFooterActions` в `deal_items.js`).

### 9.4 Инвентаризация: интерактивный канбан

`stocktake_view.js` — 4 колонки (Черновики / На согласовании / Проведены / Отклонены).
В карточке — таблица позиций с inline-вводом факта + select причины расхождения + чипы-фильтры.

### 9.5 Счётчик до следующей инвентаризации (5-е число каждого месяца)

Баннер на странице `#warehouse/stocktakes`:
- 🟢 ok — есть approved-инвентаризация в текущем периоде (от прошлого 5-го)
- 🔴 overdue — пульсирующий красный баннер если 5-е прошло без инвентаризации
- 📅 upcoming — синий «до следующей N дней»

Логика — `computeStocktakeReminder()` в `stocktake_view.js`.

---

## 10. Storage стратегия (трёхуровневая)

| Слой | Что хранится | Объём | Причина |
|---|---|---|---|
| **localStorage** | Маленькие коллекции: products, lots, deal_items, stocktakes, organizations, deals, contacts | < 5 МБ | Синхронный доступ, легко sync через worker /store/pull /store/push |
| **IndexedDB** | warehouse_movements, warehouse_documents | до 50+ МБ | localStorage 10 МБ лимит Chrome не хватает после импорта |
| **Cloudflare D1** | Canonical storage всего, через worker pllato-comm | unlimited | Источник истины, sync между устройствами |

Sync схема:
- При логине → `Store.cloudBootstrap()` → `/store/pull` → localStorage заполняется
- При мутации → `Store.update(...)` пишет в localStorage сразу + `scheduleFlush(1500ms)` → `/store/push` → D1
- Для срочных операций (field submit) → `Store.cloudFlushNow()` — без debounce

`warehouse_movements` и `warehouse_documents` **исключены** из `AUTO_COLLECTIONS` в
`app/store.js` — они в IndexedDB и НЕ синкаются через cloud (импорт книги учёта = 30
МБ, нагружать worker нельзя). Это known tradeoff: история движений локальна каждому
устройству.

См. `app/wh_movements_db.js`:

```js
const DB_NAME = "pllato_warehouse";
const DB_VERSION = 2;
const STORE_NAME = "movements";

export async function putManyMovements(items, batchSize = 1000) {
  const db = await openDb();
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      batch.forEach((m) => store.put(m));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}
```

Индексы: `productId`, `lotId`, `date`, `docId`. По ним рендерятся истории движений в карточке товара.

---

## 11. Tenant isolation

Все коллекции хранятся в одной D1, но изолируются по полю в JSON-документе (`tenantId`).

В worker'е `handleStorePush` (потенциально) подменяет `tenantId` на текущего юзера —
паранойя на случай если фронт попытается «угадать» чужие данные.

Каждый клиент = отдельный workspace. В рамках одного тенанта Aminamed используется
поле `entity` («ТОО» / «ИП») для разделения складов 5 юр.лиц.

---

## 12. KPI и алерты на главной склада

`listWarehouseKpis()` и `listWarehouseAlerts()` в `warehouse.js`.

**KPI**:
- Активных SKU
- Сумма остатков (по себестоимости)
- Партий со сроком < 30 дней
- Движений за сегодня / неделю

**Алерты**:
- Партии с истёкшим сроком годности → пометить «K списанию»
- Партии < 30 дней до окончания → уведомление
- SKU с остатком 0 → если был активен, сигнал «дозаказать»
- SKU с большим расходом за неделю → KPI «быстро убывающие»

---

## 13. Что НЕ входит в WMS

Намеренно вынесено в другие модули или отложено:

- **1С Бухгалтерия интеграция** — отдельный коннектор (см. §7.3)
- **Штрих-кодирование с физическими сканерами** — отложено, в карточке номенклатуры
  пока только поля штрих-кода; интеграция оборудования = отдельный спецзаказ
- **Адресное хранение** (cell/bin location на складе) — не реализовано, у клиента
  пока единый «склад» без разбиения на полки/зоны
- **Резерв товара под счёт** — есть в плане доп.соглашения, но в текущем коде нет
- **Контроль остатков «за минусом резерва»** — то же
- **Отчёт «Движение приход-расход»** — в плане директорских отчётов
- **Multi-warehouse** (несколько физических складов) — у клиента один склад с
  разделением по юр.лицу

---

## 14. Известные ловушки при реимплементации

1. **encodeURIComponent для токена Telegram** — НЕ кодировать, `:` валидный символ.
   `wrangler secret put` может сохранить пробелы/CRLF — делать `.trim()` перед использованием.
2. **`scheduleFlush` гонка с UI** — для `markDealOrderShipped` после `createInvoiceFromDeal`
   нужен **синхронный вызов**, не через `import().then()` (Cloudflare Workers терминируют isolate сразу после Response).
3. **`field_tg_notifications` идемпотентность** — `INSERT OR IGNORE` + при ошибке `sendMessage` откат записи для retry.
4. **Pipelines не синхронизируются** — у каждого клиента свой `pipelineId`. Worker подменяет на canonical через env vars.
5. **Listeners накапливаются при rerender** — для всех больших view (field_order, preliminary_orders, stocktake_view) используется флаг `container.dataset.{name}Wired = "1"` для однократной подписки.
6. **Дедуп товаров по `(sku, entity)`** — ИП и ТОО имеют разные карточки с одним SKU. Раздельные остатки.
7. **Wrangler парент-конфиг** — всегда `wrangler deploy --config worker/wrangler.toml`, иначе перехватит родительский `Cloude/wrangler.jsonc` и задеплоит не туда.
8. **`min-width: 0` на колонке канбана** — иначе длинный текст карточки растягивает grid и ломает раскладку.
9. **При отмене документа** — восстанавливаем `lots.currentQty` симметрично, но если за это время были другие движения по lot — нужны fallback. У нас этой ситуации избегаем через `status != "cancelled"` в `findInvoiceByDeal`.
10. **CSS heading `outlineLevel`** обязателен для TOC в docx-генераторе (если будете делать PDF/DOCX отчёты).

---

## 15. Минимальный набор для воспроизведения

Если делаете с нуля, начать с этого порядка:

1. **Модель** (§2.1–2.4): products, lots, movements, documents
2. **CRUD товара** (`saveWarehouseProduct`, `listWarehouseProducts`) + UI карточки + список
3. **Документ прихода** (`createWarehouseDocument` + `postWarehouseDocument` для type=receipt) — создаёт lots
4. **Документ расхода** (для type=sale_invoice) — FIFO-списание через `buildPostingPlan`
5. **Карточка товара** — `productSummary` (текущий остаток) + `listGroupedMovementsByLot`
6. **Канбан заказов** (`preliminary_orders.js`) — нужно сначала `deal_items.js`
7. **Печать З-2** — `invoice_print.js` + справочник `organizations`
8. **Инвентаризация** (§4.4) — `stocktake.js` + `stocktake_view.js`
9. **Печать ИНВ-3** — `stocktake_print.js`
10. **Импорт Excel** — `import_xlsx.js` + IndexedDB слои
11. **Отчёты и KPI** (§12)
12. **Интеграция с CRM** через `deal_items.js` (§5)

---

## 16. Ссылки на код

Все файлы по абсолютным путям в репо:

```
app/warehouse.js                          ─ ядро WMS
app/stocktake.js                          ─ инвентаризация
app/deal_items.js                         ─ заказ в сделке + статусы
app/organizations.js                      ─ юр.лица
app/wh_movements_db.js                    ─ IndexedDB movements
app/wh_documents_db.js                    ─ IndexedDB documents
app/views/warehouse/index.js              ─ shell + router
app/views/warehouse/products_list.js      ─ список SKU
app/views/warehouse/product_card.js       ─ карточка товара
app/views/warehouse/documents_list.js     ─ список документов
app/views/warehouse/document_form.js      ─ форма документа
app/views/warehouse/preliminary_orders.js ─ канбан заказов 3 колонки
app/views/warehouse/stocktake_view.js     ─ инвентаризация UI
app/views/warehouse/stocktake_print.js    ─ печать ИНВ-3
app/views/warehouse/invoice_print.js      ─ печать З-2
app/views/warehouse/import_xlsx.js        ─ импорт Excel
app/views/warehouse/reports.js            ─ отчёты
worker/worker.js                          ─ backend (handleStorePush, notifyFieldDealsToTelegram)
```

---

**Объём кода**: ~7 300 строк JS суммарно по WMS-модулю (без учёта общих утилит CRM).
**Время реализации с нуля**: 4-6 недель для опытного fullstack-разработчика
(2-3 на ядро + документооборот, 1 на инвентаризацию, 1 на канбан и интеграцию с CRM,
1 на печатные формы и polishing).
