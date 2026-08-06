import pathlib
import sys

from rembg import new_session, remove


def flag(value: str) -> bool:
    return value == "1"


def main() -> None:
    if len(sys.argv) != 9:
        raise ValueError("invalid background-removal arguments")

    source = pathlib.Path(sys.argv[1])
    destination = pathlib.Path(sys.argv[2])
    model = sys.argv[3]
    alpha_matting = flag(sys.argv[4])
    foreground_threshold = int(sys.argv[5])
    background_threshold = int(sys.argv[6])
    erode_size = int(sys.argv[7])
    post_process_mask = flag(sys.argv[8])

    session = new_session(model)
    result = remove(
        source.read_bytes(),
        session=session,
        alpha_matting=alpha_matting,
        alpha_matting_foreground_threshold=foreground_threshold,
        alpha_matting_background_threshold=background_threshold,
        alpha_matting_erode_size=erode_size,
        post_process_mask=post_process_mask,
        force_return_bytes=True,
    )
    destination.write_bytes(result)


if __name__ == "__main__":
    main()
