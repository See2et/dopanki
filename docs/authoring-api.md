# Dopanki 教材管理API

画面とAIが共通に使うHTTP API。ベースURLは `/api/manage`。JSONで送受信し、変更リクエストの `Content-Type` は `application/json` とする。実環境はHTTPSを使用する。画面からAPIトークンを発行し、`Authorization: Bearer dpk_...` を送る。本番ではCloudflare Accessの認証も必要。ブラウザはAccessセッション、AIなどの機械はAccessのサービス認証とDopankiのAPIトークンを併用する。サービス認証だけではブラウザ用の権限を得られない。

## 認証・権限

- `content:read`: デッキ・ノートタイプ・教材・編集履歴の取得。
- `content:write`: デッキ・教材の作成編集。
- `types:write`: ノートタイプの作成編集。

読み取り権限は明示的に付与する。APIトークンでは学習回答、取り消し、バックアップ、ログイン、初期設定、トークン管理を操作できない。トークンの管理は画面ログインによるセッション専用。サーバーにはトークンのSHA-256ハッシュだけを保存し、秘密の平文は発行時の応答で一度だけ返す。発行応答を失って同じ操作を再送した場合は `token:null`。そのトークンを失効させて新しく発行する。

## 再送・競合

すべての変更に `requestId`（16〜100文字、英数字・`_`・`-`）を付ける。同じ認証主体、requestId、URL、HTTPメソッド、JSON本文の再送では同じ結果を返す。本文のキー順も同一に保つ。別の操作に同じrequestIdを使うと409。同じ操作を通信失敗で再送するときはrequestIdを変えない。

編集には取得した `version` を付ける。古いversionは409。フィールド・テンプレートの追加や並べ替えも、対象ノートの内容バージョンを必要に応じて更新する。409では対象を再取得して変更を確認し、新しいrequestIdで編集する。

1回の入力は512KB以下。400は入力不備、401は認証または権限不足、404は対象なし、409は競合または整合性制約、413は入力サイズ超過。失敗時は `{ "error": "説明" }`。保存はD1バッチで履歴と結果を含めて原子的に実行する。

## ノートタイプ

| メソッド・パス | 入力・応答 |
|---|---|
| GET `/note-types` | `{noteTypes: [...]}` |
| GET `/note-types/:id` | `{noteType: ...}` |
| POST `/note-types` | 定義＋requestId → `{noteType: ...}` |
| PATCH `/note-types/:id` | 定義全体＋version＋requestId → `{noteType: ...}` |

定義の例：

```json
{
  "requestId": "create-korean-type-0001",
  "name": "韓国語",
  "fieldDefinitions": [
    {"id": "jp", "name": "日本語", "required": true},
    {"id": "kr", "name": "韓国語", "required": true},
    {"id": "instruction", "name": "回答の指示", "required": false}
  ],
  "templates": [
    {
      "id": "jp-to-kr", "name": "日本語→韓国語",
      "front": "{{日本語}}<br>{{回答の指示}}{{type:韓国語}}",
      "back": "{{FrontSide}}<hr>{{type:韓国語}}{{tts ko_KR:韓国語}}"
    }
  ],
  "css": ".card { font-size: 28px; }"
}
```

フィールド・テンプレートのIDは1〜100文字の英数字・ハイフン・アンダースコアで、ノートタイプ内で一意かつ変更しない。順序や名前は変更できる。フィールド名に `: { }` と改行は使えない。`Tags Type Deck Subdeck Card FrontSide` は組み込み参照として予約される。1タイプは1〜32フィールド、1〜16テンプレート。表裏各30,000文字、CSS40,000文字以下。

既存テンプレートの本文を変えずにフィールド名だけを変えると、参照を自動更新する。本文を編集する場合、新しいフィールド名で参照を書く。`{{項目}}`、`{{#項目}}...{{/項目}}`、`{{^項目}}...{{/項目}}`、`{{FrontSide}}`、`{{type:項目}}`、`{{tts ko_KR:項目}}` など既存レンダラーの構文を使う。自由なHTML/CSSはスクリプト禁止のiframeに表示する。JavaScriptは実行しない。

使用中のフィールド・テンプレートは削除できない。使用中タイプへ必須フィールドを追加すると、既存値が空欄になるため保存を拒否する。まず任意として追加し、教材へ値を入れてから必須へ変更する。

通常形式（`kind:normal`）の作成・編集に対応する。取り込んだ穴埋め形式は取得・教材内容の編集はできるが、タイプの構造編集や新規教材生成は対象外。

### 品詞・活用ラベル

画面のノートタイプ編集で「品詞・活用ラベルを追加」を押すと、未保存の下書きに次を加える。保存は通常の PATCH `/note-types/:id` で、既存カードの学習状態は変わらない。

- 任意フィールド「品詞」「変格活用」。同名フィールドがあれば再利用し、IDや必須設定を変えない。
- 各テンプレートの裏面末尾に、まだ参照していないフィールドだけの小さなラベル（`{{#品詞}}…{{/品詞}}` 形式）。表面・既存の参照・解答入力・読み上げは変えない。カードテンプレートは増えない。保存済みから未編集の裏面にラベルを足すときは、未保存のフィールド名変更をサーバーの自動更新と同じ規則で先に反映する。編集済みの裏面はそのまま残す。
- 共通CSSの末尾にラベル用スタイル（`/* dopanki:korean-grammar-labels */` 以降）を1回だけ追加する。

何度押しても重複しない。上記の32フィールド・30,000文字・40,000文字を超える場合は下書きを変えずに中止する。値は教材ごとに入力し、一括では埋めない。空欄（空白のみを含む）のカードではラベルも余白も表示しない。APIから同じ構成を作る場合は、`web/korean-grammar.ts` の `applyKoreanGrammarLabels` の出力を定義全体として送る。

## ノートとカード

| メソッド・パス | 入力・応答 |
|---|---|
| GET `/notes?q=&deckId=&noteTypeId=&offset=0&limit=30` | `{notes:[...], total:数}`。limit上限100、deckIdは指定デッキ自身を対象とする |
| GET `/notes/:id` | `{note: ...}` |
| POST `/notes` | requestId、noteTypeId、deckId、fields、任意のtags → `{note: ...}` |
| PATCH `/notes/:id` | requestId、version、任意のfields・tags・deckId・suspended → `{note: ...}` |
| GET `/notes/:id/history` | `{history:[{id,before,after,actor,createdAt}]}`、直近100件 |
| POST `/notes/bulk` | requestId、items → `{results:[...]}` |

追加の例：

```json
{
  "requestId": "create-korean-note-0001",
  "noteTypeId": "ノートタイプのID",
  "deckId": "デッキのID",
  "fields": {"日本語": "職場", "韓国語": "직장"},
  "tags": ["仕事"]
}
```

編集のfieldsは部分更新。指定しない項目は保持し、空文字を指定すれば空欄にする。未定義フィールドや必須項目の空欄は拒否。tagsを指定した場合は配列全体を置き換える。

新規ノートはプレーンテキストとして保存し、HTML記号をエスケープして改行を表示する。既存のAnki由来ノートはHTML互換性を保持する。応答の `contentFormat` で区別できる。

1ノートからテンプレートごとにカードを生成する。内容・表示テンプレート・CSS・フィールドの順序や名前を編集しても、既存カードの復習予定・記憶状態・学習リビジョン・回答履歴は変更しない。テンプレートの追加で生じたカードだけを未学習として生成する。テンプレートの並べ替えでも既存カードIDを保つ。

応答はフィールド名をキーとするfields、version、tags、contentFormatと `cards:[{id,deckId,templateId,suspended}]` を含む。ノートタイプは編集で変更できない。deckId・suspendedを変更すると、そのノートの全カードへ適用する。出題停止・再開では記憶状態を保持する。編集履歴のbefore/afterは保存したノートオブジェクト（fieldsは配列）。バックアップは履歴も含むが、復元ツールは今回の範囲外。

一括操作は最大20項目。requestIdは16〜80文字。各項目は `{operation:"create", ...追加入力}` または `{operation:"update", id, version, ...編集入力}`。不正な項目は保存せず、検証に通った項目をまとめて原子的に保存する。保存時に競合を検出した場合、そのまとまりの未保存項目に409を返す。成功は `{index,ok:true,note}`、失敗は `{index,ok:false,status,error}`。検証に失敗した項目があっても、ほかの有効な項目は保存できる。D1のクエリ数は件数・テンプレート数によらず一定に保つ。一括保存用の各データ集合は1.5MB以下で、超える場合は413として書き込み前に拒否するため、件数を分けて再送する。再送は同じ項目順・本文・requestIdを使う。

## デッキ

| メソッド・パス | 入力・応答 |
|---|---|
| GET `/decks` | `{decks:[...]}`、version付き |
| POST `/decks` | requestId、name、任意のparentId・config → `{deck:...}` |
| PATCH `/decks/:id` | requestId、version、任意のname・parentId・config → `{deck:...}` |

nameは階層を含まない末端名。parentId:nullでルートへ移動する。親デッキの名前変更・移動は子孫の名前にも反映し、カードの所属IDは維持する。重複名や循環階層は拒否する。config.reviewPerDay:nullで復習上限を解除する。configの省略項目は既存設定を保持し、作成時はFSRSの既定設定（新規20、復習200）を使う。

## セッション専用操作

- POST `/setup`: `{requestId,timeZone:"Asia/Tokyo",dayStart:4}`。Ankiなしの初期コレクションを作る。既存コレクションは上書きしない。
- GET `/tokens`: `{tokens:[{id,name,scopes,createdAt,revoked}]}`。
- POST `/tokens`: `{requestId,name,scopes:[...]}` → `{token,info}`。
- POST `/tokens/:id/revoke`: `{requestId}` → `{ok:true}`。
