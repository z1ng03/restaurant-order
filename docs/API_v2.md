# API - изменения и новые эндпоинты (ТЗ v2)

Базовый адрес: `/api`. Ошибки всегда `{ "error": { "code", "message", "details?" } }`: **`code` стабилен** (по нему переключается фронтенд), `message` - русский текст для пользователя. Деньги - строки с двумя знаками (`"3200.00"`), количества ингредиентов - в **базовой единице ингредиента** (`kg`/`l`/`pcs`, строки с тремя знаками); на экране они показываются как «40 г», «100 мл», «1 шт.».

## Заголовки

| Заголовок | Кому | Зачем |
|---|---|---|
| `X-Kiosk-Session-Token` | гостевые запросы терминала | секрет сессии стола из `POST /sessions/open`; без него корзина/заказ/трекер/чек недоступны (`403 INVALID_SESSION_ACCESS`) |
| `X-Device-Secret` | `POST /sessions/open` | зарегистрированный секрет устройства (в production обязателен) |
| `Authorization: Bearer …` | персонал **или** клиент | токены разных типов и с разными секретами: токен персонала не открывает клиентские маршруты и наоборот |
| `Idempotency-Key` | `POST /checkout/:sessionId/confirm` | повтор того же ключа с тем же телом → тот же заказ (`200`, `idempotentReplay: true`); другое тело → `409 IDEMPOTENCY_CONFLICT` |

## Гость (терминал стола)

| Метод и путь | Доступ | Заметки |
|---|---|---|
| `POST /sessions/open` | `X-Device-Secret` (prod) | возвращает `kioskSessionToken` (один раз; при повторном открытии с действующим секретом он не меняется, иначе ротируется) |
| `GET /sessions/:id`, `GET /sessions/:id/orders` | секрет киоска (read) | заказы включают `tracking`; без данных аккаунта |
| `GET /menu` | публично | + `available`, `unavailableReason`, `unavailableMessage` |
| `GET /menu/dishes/:id` | публично | + `ingredients[]` (`baseQuantity`, `stepQuantity`, `selectedQuantity`, `minQuantity`, `maxQuantity`, `customizable`, `allergens[]`), `allergenGroups[]`, ручные `allergens[]`, `options[]` с доступностью |
| `POST /menu/dishes/:id/check-configuration` | публично | «можно ли приготовить **именно этот** состав сейчас»; те же коды ошибок состава, что и при добавлении |
| `GET /cart/:sessionId` | секрет киоска (+ необязательный токен клиента) | `items[].ingredients[]` (на порцию и на всю позицию), `comment`, `priceChanges`, `loyaltyPreview`; `?useCashback=true` показывает итог со скидкой |
| `POST /cart/:sessionId/items` | секрет киоска (write) | тело: `dishId`, `quantity`, `ingredients[{ingredientId, quantity, unit?}]`, `options[{optionId, quantity}]` |
| `PATCH /cart/:sessionId/comment` | write | один комментарий на заказ, ≤ 500 символов |
| `POST /cart/:sessionId/price-confirmation` | write | подтверждение новых цен после «заказать ещё раз» |
| `PATCH/DELETE /cart/items/:id`, `DELETE /cart/:sessionId` | write | смена количества заново проверяет состав и склад |
| `GET /checkout/:sessionId/validate` | write | `issues[]`, `configurationAvailable`, `loyaltyPreview`, `payableTotal` |
| `POST /checkout/:sessionId/confirm` | write + `Idempotency-Key` | тело: `paymentMethod` (`CASH`/`KASPI_QR`), `useCashback?`, `expectedPayableTotal?`; сумма бонусов **только** считается сервером |
| `POST /age-verification` | write + rate-limit | подтверждение 21+ логином официанта |
| `GET /order-tracking/session/:sessionId` | секрет киоска (read) | этапы `ACCEPTED/PREPARING/WITH_WAITER/DELIVERED`, времена, `statusLabel`, отмена |
| `GET /orders/:orderId/receipt` | секрет киоска **этой** сессии, владелец-клиент, персонал (ADMIN/WAITER) | `409 PAYMENT_NOT_SETTLED`, пока заказ не оплачен |

## Клиентский аккаунт

`/client-auth/{register,login,logout}` - вход привязывается к сессии стола, если передан `kioskSessionId` и секрет киоска. Остальное - `Authorization: Bearer <токен клиента>`:

`GET /client-account/me` · `PATCH /password` (`oldPassword`,`newPassword`; все сессии отзываются) · `DELETE /me` (`password`, `confirm:true`; анонимизация) · `GET|POST /identity-verification`, `POST /identity-verification/demo-confirm` (только вне production; `403 DEMO_MODE_DISABLED`) · `GET /loyalty?limit&cursor` · `GET /orders?limit&cursor`, `GET /orders/:id` · `POST /orders/:id/rating` · `POST /orders/:id/reorder` (+ секрет киоска; ответ: `addedItems`, `unavailableItems`, `priceChanged`, `warnings`, `cart`) · `POST /orders/:id/receipt/email|telegram` · `POST /telegram/link`, `DELETE /telegram`.

Чужой или несуществующий заказ - одинаковый `404 ORDER_NOT_OWNED`.

## Персонал

| Метод и путь | Роль | Изменение |
|---|---|---|
| `GET /kitchen/orders`, `PATCH /kitchen/order-items/:id/status` | CHEF | `comment`, `ingredientsActual[]` (факт заказа с пометками `REMOVED/CHANGED/ADDED`), `statusEvents`; переход выполняется под блокировкой заказа, повтор безвреден, отменённый заказ двигать нельзя |
| `GET /waiter/orders`, `PATCH …/pickup|cash-received|delivered` | WAITER | `comment`, суммы с учётом бонусов; `cash-received` создаёт чек и начисляет бонусы **один раз** |
| `POST /admin/orders/:id/cancel` | ADMIN | `{reason?, refundDecision?: "REFUND"\|"NO_REFUND"}`; ответ содержит `cancellation` |
| `PATCH /admin/ingredients/:id/stock` | ADMIN | `{stockQuantity, reason?, comment?}`; ниже резерва нельзя (`409 STOCK_BELOW_RESERVED`) |
| `POST /admin/ingredients/:id/stock/receive`, `…/write-off` | ADMIN | приёмка / списание |
| `GET /admin/inventory-adjustments?ingredientId&limit` | ADMIN | журнал склада |
| `GET\|POST /admin/ingredient-allergens`, `PATCH …/:ingredientId` | ADMIN | теги аллергенов ингредиентов (`CONTAINS`/`MAY_CONTAIN`) |
| `POST/PATCH /admin/dishes` | ADMIN | `inventoryTracked`; строки рецепта: `adjustmentStep`, `isCustomizable`; активное блюдо без описания запрещено |
| `GET /admin/receipts`, `/admin/loyalty-audit`, `/admin/inventory-audit` | ADMIN | чеки с попытками отправки, сверка кэшбэка, сверка склада |
| `POST /integrations/telegram/webhook` | Telegram | заголовок `X-Telegram-Bot-Api-Secret-Token` |

## Коды ошибок (основные)

`INVALID_SESSION_ACCESS`, `SESSION_ENDED`, `DEVICE_NOT_AUTHORIZED`, `DEVICE_NOT_REGISTERED` · `INGREDIENT_NOT_IN_DISH`, `INVALID_INGREDIENT_STEP`, `INGREDIENT_OUT_OF_RANGE`, `INGREDIENT_NOT_CUSTOMIZABLE`, `UNIT_MISMATCH`, `OPTION_NOT_AVAILABLE`, `OPTION_UNAVAILABLE` · `DISH_UNAVAILABLE`, `INSUFFICIENT_INGREDIENTS`, `CHECKOUT_VALIDATION_FAILED` (`details.issues[]`: `EMPTY_CART`, `DISH_INACTIVE`, `INGREDIENT_INACTIVE`, `INSUFFICIENT_INGREDIENTS`, `AGE_VERIFICATION_REQUIRED`, `PRICE_CONFIRMATION_REQUIRED`, `ZERO_TOTAL`) · `IDEMPOTENCY_CONFLICT`, `IDEMPOTENCY_IN_PROGRESS` · `CASHBACK_INSUFFICIENT`, `CASHBACK_CONFLICT`, `CLIENT_UNAUTHORIZED`, `CLIENT_SESSION_ENDED` · `INVALID_CREDENTIALS`, `LOGIN_LOCKED`, `REGISTRATION_FAILED`, `WRONG_PASSWORD`, `ACCOUNT_HAS_ACTIVE_ORDERS`, `RATE_LIMITED` · `ORDER_NOT_OWNED`, `ORDER_NOT_RATEABLE`, `ORDER_ALREADY_RATED` · `PAYMENT_NOT_SETTLED`, `RECEIPT_NOT_READY`, `DELIVERY_PROVIDER_NOT_CONFIGURED`, `RECEIPT_SEND_FAILED`, `RECIPIENT_NOT_VERIFIED`, `TELEGRAM_NOT_LINKED` · `IDENTITY_VERIFICATION_REQUIRED`, `IDENTITY_PROVIDER_NOT_CONFIGURED`, `DEMO_MODE_DISABLED`, `INVALID_FILE` · `STOCK_BELOW_RESERVED`, `UNIT_CHANGE_FORBIDDEN`, `INVENTORY_INCONSISTENT`.
