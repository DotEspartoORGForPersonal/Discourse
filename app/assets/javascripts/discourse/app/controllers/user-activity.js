import Controller, { inject as controller } from "@ember/controller";
import I18n from "I18n";
import { alias } from "@ember/object/computed";
import { exportUserArchive } from "discourse/lib/export-csv";
import { inject as service } from "@ember/service";
import discourseComputed, { observes } from "discourse-common/utils/decorators";

export default Controller.extend({
  dialog: service(),
  application: controller(),
  user: controller(),
  userActionType: null,

  canDownloadPosts: alias("user.viewingSelf"),

  @observes("userActionType", "model.stream.itemsLoaded")
  _showFooter() {
    let showFooter;
    if (this.userActionType) {
      const stat = (this.get("model.stats") || []).find(
        (s) => s.action_type === this.userActionType
      );
      showFooter = stat && stat.count <= this.get("model.stream.itemsLoaded");
    } else {
      showFooter =
        this.get("model.statsCountNonPM") <=
        this.get("model.stream.itemsLoaded");
    }
    this.set("application.showFooter", showFooter);
  },

  @discourseComputed("currentUser.draft_count")
  draftLabel(count) {
    return count > 0
      ? I18n.t("drafts.label_with_count", { count })
      : I18n.t("drafts.label");
  },

  @discourseComputed("model.pending_posts_count")
  pendingLabel(count) {
    return count > 0
      ? I18n.t("pending_posts.label_with_count", { count })
      : I18n.t("pending_posts.label");
  },

  actions: {
    exportUserArchive() {
      this.dialog.yesNoConfirm({
        message: I18n.t("user.download_archive.confirm"),
        didConfirm: () => exportUserArchive(),
      });
    },
  },
});
