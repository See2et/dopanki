# Dopanki

Ankiの教材と学習状態を引き継ぎ、スマホ・PCからFSRSで復習するミニマルなWebアプリです。オンライン利用を前提とします。演出と高品質AI音声の生成はまだ含みません。

## ローカルで使う

Node.js 24以降、Python 3.10〜3.13、[uv](https://docs.astral.sh/uv/)を使います。

```sh
npm ci
npm run import:anki -- /path/to/deck.apkg
npm run dev
```

PCでは http://localhost:8787 を開きます。今回提供された韓国語デッキは、すでにこの作業環境のローカルDBへ取り込み済みです。Ankiの元ファイルは変更しません。

通常の開発サーバーとViteは127.0.0.1だけで待ち受けます。スマホから使う場合は、`.dev.vars`にパスワードを設定し、専用のLAN起動コマンドを使います。同じWi-FiからWranglerが表示するLANアドレスを開いてください。

```sh
printf 'APP_PASSWORD="%s"\n' "$(openssl rand -hex 24)" > .dev.vars
npm run dev:lan
```

ログインには`.dev.vars`に保存したパスワードを使います。`dev:lan`はパスワード未設定なら起動を停止します。端末の韓国語音声が未導入の場合は、端末の音声設定から追加してください。

フロントエンド編集中は別ターミナルで`npm run dev:web`を使えます。ViteからAPIをlocalhost:8787へ転送します。

## Ankiの取り込み

Ankiから「スケジュール情報」「デッキのプリセット」「メディア」を含めて`.apkg`または`.colpkg`を書き出します。PCのCLIで変換し、D1へ登録します。ブラウザへのAPKGアップロードは未対応です。

```sh
npm run import:anki -- /path/to/deck.apkg --timezone Asia/Tokyo --day-start 4
```

`--day-start`はAnkiで設定していた日付切り替わりの時刻です。APKGに含まれない場合は午前4時を使用し、画面に確認事項を表示します。タイムゾーンの既定値はAsia/Tokyoです。

- 現行のZIP＋Zstandard＋protobuf形式と、旧形式のSQLite＋JSONに対応します。
- 元のノート・カードID、フィールド、テンプレート、CSS、画像・音声、回答履歴、FSRSパラメータと記憶状態、復習予定を保存します。
- 学習中・再学習中のステップ、停止・一時埋め込み状態を引き継ぎます。一時埋め込みは取り込み後の次の学習日に解除します。
- 初回取り込みで復習予定を再計算しません。次の回答からDopankiのFSRSで更新します。
- 学習済みカードにFSRS記憶状態がない場合は、正の間隔・easeがあればSM-2から推定し、警告します。推定できない状態は取り込みを停止します。
- 同じDBへの再取り込みは停止します。継続中の学習状態を上書きしません。取り込み失敗時は教材を公開せず、同じ操作の再実行で未完了分を読み直せます。取り込みコマンドは同時に実行しないでください。

変換結果は`.local/import/collection.json`、メディアは`.local/import/media/`です。`.local`、`.wrangler`、`.dev.vars`はGitに含みません。

## 学習機能

- 表裏・逆方向・穴埋め、条件付きフィールド、`FrontSide`、入力回答、ふりがな、添付音声に対応します。
- `{{tts ko_KR:KR}}`などと`[anki:tts]`の読み上げ対象・言語・速度を解釈し、ブラウザの端末音声で再生します。AwesomeTTSの声や生成モデルを再現する機能ではありません。
- Again / Hard / Good / Easyの4段階で評価します。Space・Enterで答え表示、1〜4で評価できます。
- 回答はサーバーでFSRS計算して保存します。再送は同じ回答IDで行い、二重記録を防ぎます。別画面との競合は409として検出し、読み直します。
- 直前の回答を取り消せます。同じカードがその後に更新された場合は取り消せません。履歴は削除せず取り消し済みとして保存します。
- デッキを親・子・孫のツリーで表示します。配下の開閉状態は次回も保持します。親デッキから配下をまとめて復習でき、カードのFSRS計算には所属する子デッキの設定を使います。
- 件数と今日の回答数は配下を含めて集計し、日次上限には移行した当日の履歴も含めます。親から学習する場合は親と各子の上限を適用し、子だけを選んだ場合は上の親の上限を適用しません。Ankiの出題順と一部の日次上限オプションの完全再現は未対応です。
- 上部の「バックアップ」で教材・元履歴・現在状態・Dopanki回答履歴をJSONで保存できます。これはAnkiへの書き戻し用APKGではありません。復元ツールはまだありません。

カードHTML/CSSはスクリプトを実行できないiframeに表示します。任意JavaScript、アドオン独自フィルター、画像穴埋め、フィルターデッキのプレビュー状態は未対応です。未対応フィルターは画面で報告します。

## 構成とFSRS

| 場所 | 役割 |
|---|---|
| `scripts/import_anki.py` | 元ID・予定を保持したAnkiパッケージ変換 |
| `src/tools/import-anki.ts` | 変換・DB登録・メディアアップロードのCLI |
| `src/lib/scheduler.ts` | FSRS、学習ステップ、タイムゾーンと日境界 |
| `src/lib/render.ts` | Ankiテンプレート解釈 |
| `src/server/index.ts` | 認証、出題、回答、取り消し、バックアップ |
| `web/` | スマホ対応の最小UI |
| `migrations/` | D1のDBスキーマ |

`ts-fsrs@5.4.2`のFSRS計算を使用します。FSRS-4/5/6の17/19/21パラメータを保持して変換し、native `fsrs-rs`の参照値で検証しています。Ankiと同じ学習ステップと日境界を扱いますが、fuzzは無効で、スケジューラ全体の完全一致は保証しません。パラメータ最適化は未実装です。

Rust版のWorkers用WASMビルドはgetrandomのJavaScript依存で追加の構成が必要になったため、まず動作するTypeScript実装を採用しました。スケジューラの境界を分離しており、後から差し替えられます。

## 検証

```sh
npm run typecheck
npm test
.venv/bin/python -W error::ResourceWarning -m unittest discover -s tests/importer -v
npm run build
```

実デッキを取り込んで開発サーバーを起動した後、ブラウザの実操作も検証できます。テストは1回答を保存してから取り消すため、カードの予定と記憶状態は戻りますが、取り消しの履歴とリビジョンは残ります。

```sh
npx playwright install chromium
npm run test:e2e
```

## Cloudflareに配置する

Workers＋D1＋R2用の構成とドライラン検証を用意しています。この作業ではまだ外部へ公開していません。

```sh
npx wrangler login
npx wrangler d1 create dopanki
npx wrangler r2 bucket create dopanki-media
```

表示されたdatabase_idを`wrangler.toml`へ設定します。次にログイン用の秘密とDBを準備します。

```sh
npx wrangler secret put APP_PASSWORD
npx wrangler d1 migrations apply dopanki --remote
npm run import:anki -- /path/to/deck.apkg --remote
npm run deploy
```

公開環境ではAPP_PASSWORDを必須にしています。単一の個人コレクション用で、ユーザー登録・複数ユーザー分離・Ankiとの双方向同期はまだありません。
