# Shop-Modul lusdigital: Mails zu neuen Heften

Das Modul liegt ohne Git auf dem Verlagsserver
(`/var/www/vhosts/lesenundschenken.de/httpdocs/modules/lusdigital/`). Hier
steht, was am 28.10.2026 fuer die Heft-Mails dazukam
(`docs/shop-integration.md`, Abschnitt „Mails zu neuen Heften“):

* `classes/LusdigitalHeftMail.php` und `mails/de/lusdigital_heft.{html,txt}`:
  neu, 1:1 so auf dem Server.
* `classes/LusdigitalLoginMail.php`: Kopie vom Server, seit 30.10.2026 ohne
  Heft-Mails im Stundenlimit. Sicherungen: `*.bak-20261030`.
* `api.php.diff` (`controllers/front/api.php`, Aktion `heft_mail`) und
  `lusdigital.php.diff` (Hook `actionMailAlterMessageBeforeSend`): nur die
  Aenderung; die Dateien selbst pflegen auch Kollegen direkt auf dem Server.
  Sicherungen davor: `*.bak-20261028`.

Der Hook wurde einmalig registriert:

    cd /var/www/vhosts/lesenundschenken.de/httpdocs
    sudo -u lus_shop /opt/plesk/php/8.2/bin/php -r 'require "config/config.inc.php";
      var_dump(Module::getInstanceByName("lusdigital")->registerHook("actionMailAlterMessageBeforeSend"));'
