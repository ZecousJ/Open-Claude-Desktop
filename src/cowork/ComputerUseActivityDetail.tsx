import type { Item } from "../../shared/types";
import { ComputerUseToolView } from "../computer-use/ComputerUseToolView";
import { Modal } from "../ui/Controls";

export function ComputerUseActivityDetail({
  items,
  source,
  onClose,
}: {
  items: Item[];
  source?: string;
  onClose: () => void;
}) {
  return (
    <Modal title="Computer use" wide onClose={onClose}>
      {source && (
        <div className="cu-lightbox">
          <img src={source} alt="" />
        </div>
      )}
      {items.map((item) => (
        <ComputerUseToolView key={item.id} item={item} />
      ))}
    </Modal>
  );
}
