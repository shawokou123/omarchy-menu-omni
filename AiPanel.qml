import QtQuick
import Quickshell
import qs.Commons
import qs.Ui

// The AI answer: status chip (agent, model, effort, state), the streaming
// answer and the key hints. State comes from the AI controller; the menu
// scrolls the answer through answerFlick.
Item {
  id: panel
  required property var menu
  required property var ai
  property alias answerFlick: aiAnswerFlick
  readonly property bool canFocusFollowUp: aiFollowUpBox.visible

  function focusFollowUp() {
    if (canFocusFollowUp) {
      followUpInput.forceActiveFocus()
    }
  }

  function doSubmitFollowUp() {
    var query = followUpInput.text.trim()
    if (!query) return
    if (panel.ai.aiIsBusy()) return
    followUpInput.text = ""
    panel.ai.aiSubmitFollowUp(query)
  }

  Connections {
    target: panel.ai
    function onIsAiModeChanged() {
      if (!panel.ai.isAiMode) {
        followUpInput.text = ""
      }
    }
  }

  Rectangle {
    id: aiChip
    height: aiChipLabel.implicitHeight + Style.space(10)
    width: aiChipLabel.implicitWidth + Style.space(18)
    radius: height / 2
    color: panel.ai.aiSession && panel.ai.aiSession.state === "error" ? Util.alpha(Color.urgent, 0.18) : Util.alpha(Color.accent, 0.22)

    Text {
      id: aiChipLabel
      anchors.centerIn: parent
      textFormat: Text.PlainText
      text: panel.ai.aiChipText()
      color: panel.ai.aiSession && panel.ai.aiSession.state === "error" ? Color.urgent : Color.accent
      font.family: panel.menu.fontFamily
      font.pixelSize: panel.menu.scaledFont(Style.font.body)
    }
  }

  Text {
    visible: panel.ai.aiConfigWarning !== ""
    anchors.left: aiChip.right
    anchors.leftMargin: Style.space(8)
    anchors.right: parent.right
    anchors.verticalCenter: aiChip.verticalCenter
    textFormat: Text.PlainText
    text: panel.ai.aiConfigWarning
    color: panel.menu.foreground
    opacity: 0.55
    elide: Text.ElideRight
    font.family: panel.menu.fontFamily
    font.pixelSize: panel.menu.scaledFont(Style.font.caption)
  }

  Rectangle {
    id: aiAnswerBox
    anchors.top: aiChip.bottom
    anchors.topMargin: panel.menu.contentSpacing
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.bottom: aiFollowUpBox.visible ? aiFollowUpBox.top : aiFooter.top
    anchors.bottomMargin: panel.menu.contentSpacing
    radius: panel.menu.cornerRadius
    color: Util.alpha(panel.menu.foreground, 0.05)
    visible: !!panel.ai.aiSession && panel.ai.aiSession.state !== "idle"

    Flickable {
      id: aiAnswerFlick
      anchors.fill: parent
      anchors.margins: Style.space(10)
      clip: true
      contentWidth: width
      contentHeight: aiAnswerText.implicitHeight
      boundsBehavior: Flickable.StopAtBounds
      property bool pinnedToBottom: true

      onContentHeightChanged: {
        if (aiAnswerFlick.pinnedToBottom)
          aiAnswerFlick.contentY = Math.max(0, aiAnswerFlick.contentHeight - aiAnswerFlick.height)
      }
      onMovementEnded: {
        aiAnswerFlick.pinnedToBottom = aiAnswerFlick.contentY >= (aiAnswerFlick.contentHeight - aiAnswerFlick.height - 4)
      }

      Text {
        id: aiAnswerText
        width: aiAnswerFlick.width
        text: panel.ai.aiFullConversationText()
        textFormat: Text.MarkdownText
        onLinkActivated: function(link) { panel.ai.aiOpenLink(link) }
        wrapMode: Text.Wrap
        color: (panel.ai.aiSession && panel.ai.aiSession.state === "error"
                && (!panel.ai.aiSession.displayedText || panel.ai.aiSession.displayedText.length === 0))
          ? Color.urgent : panel.menu.foreground
        font.family: panel.menu.fontFamily
        font.pixelSize: Math.max(22, panel.menu.scaledFont(22))
        lineHeight: 1.45
      }
    }
  }

  Rectangle {
    id: aiFollowUpBox
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.bottom: aiFooter.top
    anchors.bottomMargin: visible ? panel.menu.contentSpacing : 0
    height: visible ? Math.max(38, Math.round(panel.menu.scaledFont(Style.font.body) * 2.3)) : 0
    radius: panel.menu.cornerRadius
    color: Util.alpha(panel.menu.foreground, 0.06)
    border.width: followUpInput.activeFocus ? 1 : 0
    border.color: Util.alpha(Color.accent, 0.6)
    visible: !!panel.ai.aiSession && panel.ai.aiSession.state !== "idle"

    MouseArea {
      anchors.left: parent.left
      anchors.top: parent.top
      anchors.bottom: parent.bottom
      anchors.right: sendBtn.left
      cursorShape: Qt.IBeamCursor
      onClicked: followUpInput.forceActiveFocus()
    }

    TextInput {
      id: followUpInput
      anchors.left: parent.left
      anchors.leftMargin: Style.space(12)
      anchors.right: sendBtn.left
      anchors.rightMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
      color: panel.menu.foreground
      selectionColor: Util.alpha(Color.accent, 0.35)
      selectedTextColor: panel.menu.foreground
      font.family: panel.menu.fontFamily
      font.pixelSize: panel.menu.scaledFont(Style.font.body)
      clip: true
      selectByMouse: true
      activeFocusOnTab: false

      Text {
        anchors.fill: parent
        text: "输入追加问题…"
        color: panel.menu.foreground
        opacity: 0.38
        font: followUpInput.font
        visible: !followUpInput.text && !followUpInput.inputMethodComposing
      }

      Keys.onPressed: function(event) {
        if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
          if (!event.isAutoRepeat) {
            panel.doSubmitFollowUp()
          }
          event.accepted = true
        } else if (event.key === Qt.Key_Escape) {
          panel.menu.focusSearch()
          event.accepted = true
        } else if (event.key === Qt.Key_Up) {
          if (followUpInput.cursorPosition === 0) {
            panel.menu.focusSearch()
            event.accepted = true
          }
        }
      }
    }

    Rectangle {
      id: sendBtn
      anchors.right: parent.right
      anchors.rightMargin: Style.space(6)
      anchors.verticalCenter: parent.verticalCenter
      height: parent.height - Style.space(10)
      width: sendBtnText.implicitWidth + Style.space(20)
      radius: Math.max(4, panel.menu.cornerRadius - 2)
      readonly property bool busy: panel.ai.aiIsBusy()
      readonly property bool canSend: followUpInput.text.trim().length > 0
      color: busy ? Util.alpha(Color.urgent, 0.2) : (canSend ? Color.accent : Util.alpha(panel.menu.foreground, 0.12))

      Text {
        id: sendBtnText
        anchors.centerIn: parent
        text: sendBtn.busy ? "停止" : "发送"
        color: sendBtn.busy ? Color.urgent : (sendBtn.canSend ? Color.background : panel.menu.foreground)
        opacity: sendBtn.busy || sendBtn.canSend ? 1.0 : 0.45
        font.family: panel.menu.fontFamily
        font.pixelSize: panel.menu.scaledFont(Style.font.bodySmall)
        font.bold: true
      }

      MouseArea {
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
        onClicked: {
          if (sendBtn.busy) {
            panel.ai.aiCancel()
          } else {
            panel.doSubmitFollowUp()
          }
        }
      }
    }
  }

  Text {
    id: aiFooter
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.bottom: parent.bottom
    textFormat: Text.PlainText
    text: panel.ai.aiFooterText()
    color: panel.menu.foreground
    opacity: 0.5
    wrapMode: Text.Wrap
    font.family: panel.menu.fontFamily
    font.pixelSize: panel.menu.scaledFont(Style.font.caption)
  }
}
