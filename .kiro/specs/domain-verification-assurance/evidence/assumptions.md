# 環境・抽象化・公平性の仮定

## 実境界とfakeの差

- protocol fakeはNodeのerror code、stdout/stderr、exit code、timeout、disposeを再現するが、Windows file watcherのイベントcoalescing、アンチウイルスによるrename遅延、CLI localeは完全には再現しない。実filesystem・extension-host・制御済みの結合テストで補い、残るOS/provider差は未再現として記録する。
- local proxy fixtureは接続成功、拒否、切断、遅延を再現するが、企業proxyの認証方式・TLS interception・PAC/WPAD全体は対象外である。
- PBTのURLは`safe://proxy/<id>`等のtokenであり、実credential構文を生成しない。secret sanitizationは個別の既存テストとintegration testで確認する。

## TLA+の仮定

- actor数、target数、queue長、retry、logical time、storage容量は有限定数である。unboundedなactor/時間/容量は未探索である。
- provider failure、drop、crashを環境Actionとし、環境が無限に故障を注入する間のlivenessは保証しない。
- faultが最終的に解除され、enabledなsystem actionが無期限に実行されないことはないという公平性の下でlivenessを主張する。
- wall clock、OS scheduler、filesystemの実装差は論理時間と有限event queueに抽象化する。

## リリースへの影響

- 隔離Windows VMでの実機E2Eは本仕様の対象外であり、実機依存の成功主張は行わない。
- TLCの有限探索は、記録したconfig以外の定数組合せを証明しない。
